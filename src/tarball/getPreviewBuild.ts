import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { isPreviewPackage, isWorkspacePackage } from '../preview/packages'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import { metaKey, tarballKey } from '../cache/r2Cache'
import { tarballCacheControl } from '../cache/headers'
import { rewritePackageJson } from './rewritePackageJson'
import { assertSafeTarballPath } from '../security/validateTarballPath'
import {
  emitStoredGzip,
  rewriteTarEntryInPlace,
} from './rewriteTarballBuffer'
import {
  buildPreviewTarball,
  encodePackageJson,
  extractRewrittenPackageJson,
  PACKAGE_JSON_NAMES,
  type PreviewBuild,
  type PreviewMeta,
} from './buildPreviewTarball'
import { fetchUpstreamTarball } from './fetchUpstreamTarball'

// R2 multipart parts must be >=5 MiB and (except the last) equal-sized.
const PART_SIZE = 10 * 1024 * 1024

function mergeChunks(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

/**
 * Decompress a gzipped tar into a single right-sized buffer. Presized from the
 * gzip ISIZE trailer (decompressed length; valid for the <4GB single-member
 * tarballs npm produces) so there is no doubling from a growing collector, and
 * read incrementally so the decompressor never holds the whole output on top of
 * the buffer. The compressed input goes out of scope on return.
 */
async function decompressToBuffer(gzipped: Uint8Array): Promise<Uint8Array> {
  const isize = new DataView(
    gzipped.buffer,
    gzipped.byteOffset + gzipped.length - 4,
    4,
  ).getUint32(0, true)

  const out = new Uint8Array(isize)
  let pos = 0
  const reader = new Response(gzipped)
    .body!.pipeThrough(new DecompressionStream('gzip'))
    .getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      out.set(value, pos)
      pos += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }
  if (pos !== isize) {
    // The gzip ISIZE trailer disagreed with what we decompressed: a truncated
    // or otherwise corrupt upstream. Fail loudly rather than serve a partial.
    throw new HttpError(502, 'Upstream tarball decompressed to an unexpected size')
  }
  return out
}

/**
 * Build a platform-binary tarball into R2, then leave it to be served straight
 * from R2 (a plain byte passthrough with a Content-Length that cannot be
 * truncated, unlike a Worker-generated transform response).
 *
 * Decompress the upstream ONCE into a single buffer and rewrite package.json in
 * place, so the ~tens-of-MB binary is never copied a second time. Then frame the
 * buffer as gzip "stored" blocks straight into a multipart upload: because the
 * buffer is fully in memory, no decompressor is running during the slow R2 part
 * uploads, so nothing buffers ahead. The previous streaming build spiked past
 * the 128MB limit (Cloudflare 1102) exactly there, the decompressor ran ahead
 * while a part upload was in flight. Peak footprint is ~the decompressed payload
 * plus one part, the same envelope as buildMetaLight, which the packument path
 * already runs on these binaries. Integrity is not pinned for these packages.
 */
async function buildPlatformTarballToR2(
  env: Env,
  name: string,
  version: string,
): Promise<void> {
  const url = toPkgPrNewUrl(env, name, version)
  if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)

  const tar = await decompressToBuffer(
    await fetchUpstreamTarball(url, maxTarballBytes(env)),
  )
  rewriteTarEntryInPlace(
    tar,
    PACKAGE_JSON_NAMES,
    (data) => {
      let pkg: Record<string, any>
      try {
        pkg = JSON.parse(new TextDecoder().decode(data))
      } catch {
        throw new HttpError(422, 'Invalid package/package.json in upstream tarball')
      }
      return encodePackageJson(rewritePackageJson(pkg, name, version, env))
    },
    assertSafeTarballPath,
  )

  const upload = await env.TARBALL_CACHE.createMultipartUpload(
    tarballKey(name, version),
    {
      httpMetadata: {
        contentType: 'application/gzip',
        cacheControl: tarballCacheControl(),
      },
    },
  )

  try {
    const parts: R2UploadedPart[] = []
    let pending: Uint8Array[] = []
    let pendingLen = 0
    await emitStoredGzip(tar, async (chunk) => {
      pending.push(chunk)
      pendingLen += chunk.byteLength
      while (pendingLen >= PART_SIZE) {
        const merged = mergeChunks(pending, pendingLen)
        parts.push(
          await upload.uploadPart(parts.length + 1, merged.subarray(0, PART_SIZE)),
        )
        const rest = merged.slice(PART_SIZE) // copy so the 10MB buffer is freed
        pending = rest.byteLength ? [rest] : []
        pendingLen = rest.byteLength
      }
    })
    // The final part may be smaller than PART_SIZE.
    if (pendingLen > 0 || parts.length === 0) {
      parts.push(
        await upload.uploadPart(parts.length + 1, mergeChunks(pending, pendingLen)),
      )
    }
    await upload.complete(parts)
  } catch (err) {
    await upload.abort()
    throw err
  }
}

// Default soft wall-clock budget for a `ctx.waitUntil` prewarm (its lifetime is
// short). Date.now() in a Worker only advances on I/O, which is where the build
// spends its time, so it is a usable bound for the loop (not a precise timer).
export const PREWARM_BUDGET_MS = 20_000
// The queue consumer can run long and retries durably, so it gets a much larger
// budget to build a whole version's binaries in one pass.
export const QUEUE_PREWARM_BUDGET_MS = 5 * 60_000

/**
 * Pre-build a version's tarballs into R2 so installs are served from cache.
 *
 * Meant to run OFF the request path (via the prebuild queue, or `ctx.waitUntil`
 * as a fallback) when a ref is registered, so the heavy platform-binary build
 * never blocks a user's install. Best-effort and time-bounded: every step is
 * isolated, already-cached tarballs are skipped, and whatever does not finish is
 * still built reliably on demand (the queue also retries). Builds the two
 * preview packages first (also to enumerate the platform binaries from
 * vite-plus's rewritten optionalDependencies), then each platform binary.
 */
export async function prewarmVersion(
  env: Env,
  version: string,
  budgetMs: number = PREWARM_BUDGET_MS,
): Promise<void> {
  // getPreviewMeta builds + stores the tarball (and meta) on a miss but returns
  // the cached meta on a hit, so a queue retry after a partial OOM does not
  // re-download and re-gzip the preview packages. vite-plus's rewritten
  // package.json gives us the platform-binary set.
  let vitePlus: PreviewMeta
  try {
    vitePlus = await getPreviewMeta(env, 'vite-plus', version)
  } catch (err) {
    console.warn(`prewarm vite-plus@${version}:`, err)
    return
  }
  try {
    await getPreviewMeta(env, '@voidzero-dev/vite-plus-core', version)
  } catch (err) {
    console.warn(`prewarm core@${version}:`, err)
  }

  // The platform binaries are the workspace packages among vite-plus's
  // optionalDependencies that are not the preview packages themselves, derived
  // from the WORKSPACE_PACKAGES allowlist so adding one needs no code change.
  // Build each at the version vite-plus declares for it (what the package
  // manager will request), not at the parent version.
  const platforms = Object.entries(
    (vitePlus.packageJson.optionalDependencies as Record<string, string>) ?? {},
  ).filter(([name]) => isWorkspacePackage(name, env) && !isPreviewPackage(name))

  const start = Date.now()
  for (const [pkg, depVersion] of platforms) {
    if (Date.now() - start > budgetMs) break
    try {
      const existing = await env.TARBALL_CACHE.head(tarballKey(pkg, depVersion))
      if (!existing) await buildPlatformTarballToR2(env, pkg, depVersion)
    } catch (err) {
      console.warn(`prewarm ${pkg}@${depVersion}:`, err)
    }
  }
}

/**
 * Download the upstream tarball, rewrite it, and durably persist BOTH the
 * rewritten package.json (small "meta") and the generated tarball to R2.
 *
 * The R2 writes are awaited (not deferred via `waitUntil`) so they reliably
 * persist: this is what makes subsequent packument/tarball requests fast and,
 * crucially, deterministic under a package manager's concurrent install load.
 * This expensive path runs once per (name, version) and is normally triggered
 * by the deploy-time warm step rather than by a user install.
 */
async function buildAndStore(
  env: Env,
  name: string,
  version: string,
): Promise<PreviewBuild> {
  const url = toPkgPrNewUrl(env, name, version)
  if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)

  const upstream = await fetchUpstreamTarball(url, maxTarballBytes(env))
  const build = await buildPreviewTarball(upstream, name, version, env)
  const cacheControl = tarballCacheControl()

  const meta: PreviewMeta = {
    packageJson: build.packageJson,
    shasum: build.shasum,
    integrity: build.integrity,
  }
  await Promise.all([
    env.TARBALL_CACHE.put(tarballKey(name, version), build.tarball, {
      httpMetadata: { contentType: 'application/gzip', cacheControl },
    }),
    env.TARBALL_CACHE.put(metaKey(name, version), JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json', cacheControl },
    }),
  ])

  return build
}

/**
 * Build packument metadata for a non-preview workspace package (a platform
 * binary) without re-gzipping its large payload: parse the upstream tarball,
 * extract and rewrite package.json, and cache just the meta. The tarball itself
 * is re-built lazily on download. Integrity is omitted (the package manager
 * computes it from the downloaded tarball).
 */
async function buildMetaLight(
  env: Env,
  name: string,
  version: string,
): Promise<PreviewMeta> {
  const url = toPkgPrNewUrl(env, name, version)
  if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)

  const upstream = await fetchUpstreamTarball(url, maxTarballBytes(env))
  const packageJson = await extractRewrittenPackageJson(
    upstream,
    name,
    version,
    env,
  )
  const meta: PreviewMeta = { packageJson, shasum: '', integrity: '' }
  await env.TARBALL_CACHE.put(metaKey(name, version), JSON.stringify(meta), {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: tarballCacheControl(),
    },
  })
  return meta
}

/**
 * The cached metadata (rewritten package.json + integrity) for a preview
 * version, served from R2 when present. This is the cheap artifact the
 * packument endpoint needs (no gzip) once cached.
 */
export async function getPreviewMeta(
  env: Env,
  name: string,
  version: string,
): Promise<PreviewMeta> {
  const cached = await env.TARBALL_CACHE.get(metaKey(name, version))
  if (cached) {
    const stored = await cached.json<Record<string, any>>()
    // Tolerate the pre-integrity meta format (a bare package.json object).
    if (stored && typeof stored === 'object' && 'packageJson' in stored) {
      return stored as PreviewMeta
    }
    return { packageJson: stored, shasum: '', integrity: '' }
  }

  // Large non-preview binaries: build meta without re-gzipping (the full
  // tarball would otherwise exceed the Worker CPU limit per packument request).
  if (!isPreviewPackage(name)) return buildMetaLight(env, name, version)

  const build = await buildAndStore(env, name, version)
  return {
    packageJson: build.packageJson,
    shasum: build.shasum,
    integrity: build.integrity,
  }
}

/**
 * The generated tarball bytes for a preview version, served from R2 when
 * present.
 */
export type PreviewTarball =
  | { kind: 'body'; body: ReadableStream<Uint8Array> | Uint8Array; contentLength?: number }
  /** The platform binary was just built into R2; the caller should redirect to
   * the same URL so the (cheap) cached path serves it. Building AND serving the
   * ~48MB payload in one request exceeds the Worker limit (Cloudflare 1102), so
   * the work is split across two requests. */
  | { kind: 'redirect' }

export async function getPreviewTarballBody(
  env: Env,
  name: string,
  version: string,
): Promise<PreviewTarball> {
  // Platform binaries: serve from R2 if present (a passthrough with a
  // Content-Length that cannot be truncated), else build into R2 and redirect.
  if (!isPreviewPackage(name)) {
    const cached = await env.TARBALL_CACHE.get(tarballKey(name, version))
    if (cached) {
      return { kind: 'body', body: cached.body, contentLength: cached.size }
    }
    await buildPlatformTarballToR2(env, name, version)
    return { kind: 'redirect' }
  }

  // Small preview packages keep the buffered+cached+integrity path.
  const cached = await env.TARBALL_CACHE.get(tarballKey(name, version))
  if (cached) {
    return { kind: 'body', body: cached.body, contentLength: cached.size }
  }
  const tarball = (await buildAndStore(env, name, version)).tarball
  return { kind: 'body', body: tarball, contentLength: tarball.byteLength }
}
