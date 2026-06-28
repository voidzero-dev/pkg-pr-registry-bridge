import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { isPreviewPackage, isWorkspacePackage } from '../preview/packages'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import { metaKey, tarballKey } from '../cache/r2Cache'
import { tarballCacheControl } from '../cache/headers'
import { sha512 } from '@noble/hashes/sha2.js'
import { rewritePackageJson } from './rewritePackageJson'
import { assertSafeTarballPath } from '../security/validateTarballPath'
import { toBase64 } from '../util/encoding'
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
 * already runs on these binaries.
 *
 * The SHA-512 `dist.integrity` is computed incrementally over the output chunks
 * as they are framed (Web Crypto's digest is one-shot, so hashing the whole tgz
 * would need it in memory and re-OOM; a streaming hash never holds a second
 * copy), and stored in the meta so the packument can advertise it once built.
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
  let packageJson: Record<string, any> = {}
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
      packageJson = rewritePackageJson(pkg, name, version, env)
      return encodePackageJson(packageJson)
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
    const hash = sha512.create()
    await emitStoredGzip(tar, async (chunk) => {
      hash.update(chunk)
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

    // Persist the meta with the computed integrity so the packument advertises
    // it (the lightweight buildMetaLight path can't, having no tarball to hash).
    const meta: PreviewMeta = {
      packageJson,
      shasum: '',
      integrity: `sha512-${toBase64(hash.digest().buffer as ArrayBuffer)}`,
    }
    await env.TARBALL_CACHE.put(metaKey(name, version), JSON.stringify(meta), {
      httpMetadata: {
        contentType: 'application/json',
        cacheControl: tarballCacheControl(),
      },
    })
  } catch (err) {
    await upload.abort()
    throw err
  }
}

/**
 * Compute a tarball's SHA-512 integrity by streaming the cached R2 object
 * through the hash (bounded memory; never holds the tens-of-MB payload).
 */
async function integrityFromCachedTarball(
  env: Env,
  name: string,
  version: string,
): Promise<string | null> {
  const obj = await env.TARBALL_CACHE.get(tarballKey(name, version))
  if (!obj) return null
  const hash = sha512.create()
  const reader = obj.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      hash.update(value)
    }
  } finally {
    reader.releaseLock()
  }
  return `sha512-${toBase64(hash.digest().buffer as ArrayBuffer)}`
}

/**
 * Backfill integrity for a platform binary whose tarball is cached but whose
 * meta predates integrity. Called from prewarmVersion, so the multi-MB hash runs
 * off the request path and one-at-a-time (the packument path injects refs
 * concurrently, so hashing there piled up and OOM'd).
 */
async function backfillIntegrity(
  env: Env,
  name: string,
  version: string,
): Promise<void> {
  const cached = await env.TARBALL_CACHE.get(metaKey(name, version))
  if (!cached) return
  const stored = await cached.json<Record<string, any>>()
  const meta: PreviewMeta =
    stored && typeof stored === 'object' && 'packageJson' in stored
      ? (stored as PreviewMeta)
      : { packageJson: stored, shasum: '', integrity: '' }
  if (meta.integrity) return

  const integrity = await integrityFromCachedTarball(env, name, version)
  if (!integrity) return
  meta.integrity = integrity
  await env.TARBALL_CACHE.put(metaKey(name, version), JSON.stringify(meta), {
    httpMetadata: {
      contentType: 'application/json',
      cacheControl: tarballCacheControl(),
    },
  })
}

// Default soft wall-clock budget for a `ctx.waitUntil` prewarm (its lifetime is
// short). Date.now() in a Worker only advances on I/O, which is where the build
// spends its time, so it is a usable bound for the loop (not a precise timer).
export const PREWARM_BUDGET_MS = 20_000

/**
 * Ensure one platform binary is in R2 with integrity: build it if uncached,
 * else backfill integrity if its meta predates it. This is the unit of work the
 * prebuild queue fans out to, so each invocation does bounded CPU/memory work
 * (one ~48MB decompress + hash) and a flaky binary only retries itself.
 */
export async function prebuildPlatform(
  env: Env,
  name: string,
  version: string,
): Promise<void> {
  const existing = await env.TARBALL_CACHE.head(tarballKey(name, version))
  if (!existing) await buildPlatformTarballToR2(env, name, version)
  else await backfillIntegrity(env, name, version)
}

/**
 * The platform binaries a version needs: the workspace packages among
 * vite-plus's optionalDependencies that are not the preview packages themselves
 * (derived from the WORKSPACE_PACKAGES allowlist, so adding one needs no code
 * change), each at the version vite-plus declares for it. Building vite-plus is
 * also what makes its rewritten package.json available to read them from.
 */
async function platformBinariesOf(
  env: Env,
  version: string,
): Promise<Array<[string, string]>> {
  // getPreviewMeta builds + stores the tarball (and meta) on a miss but returns
  // the cached meta on a hit, so it is cheap on a retry.
  const vitePlus = await getPreviewMeta(env, 'vite-plus', version)
  try {
    await getPreviewMeta(env, '@voidzero-dev/vite-plus-core', version)
  } catch (err) {
    console.warn(`prewarm core@${version}:`, err)
  }
  return Object.entries(
    (vitePlus.packageJson.optionalDependencies as Record<string, string>) ?? {},
  ).filter(([name]) => isWorkspacePackage(name, env) && !isPreviewPackage(name))
}

/**
 * Fan out a version's platform-binary builds onto the queue: build the preview
 * packages, then enqueue one task per binary so each is built in its own bounded
 * invocation. Used by the queue consumer (which has PREBUILD_QUEUE bound).
 */
export async function fanOutVersion(env: Env, version: string): Promise<void> {
  let platforms: Array<[string, string]>
  try {
    platforms = await platformBinariesOf(env, version)
  } catch (err) {
    console.warn(`prewarm vite-plus@${version}:`, err)
    return
  }
  for (const [name, depVersion] of platforms) {
    await env.PREBUILD_QUEUE?.send({ version: depVersion, name })
  }
}

/**
 * Pre-build a version's tarballs into R2 INLINE (preview packages, then each
 * platform binary sequentially). The fallback for `ctx.waitUntil` when the
 * prebuild queue is not bound (local dev / tests); the queue path fans out
 * instead. Best-effort and time-bounded so it cannot run away.
 */
export async function prewarmVersion(
  env: Env,
  version: string,
  budgetMs: number = PREWARM_BUDGET_MS,
): Promise<void> {
  let platforms: Array<[string, string]>
  try {
    platforms = await platformBinariesOf(env, version)
  } catch (err) {
    console.warn(`prewarm vite-plus@${version}:`, err)
    return
  }
  const start = Date.now()
  for (const [name, depVersion] of platforms) {
    if (Date.now() - start > budgetMs) break
    try {
      await prebuildPlatform(env, name, depVersion)
    } catch (err) {
      console.warn(`prewarm ${name}@${depVersion}:`, err)
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
 * is re-built lazily on download. Integrity is left empty here (there is no
 * tarball to hash yet); it is filled in when the tarball is built, or backfilled
 * by `getPreviewMeta` from the cached tarball.
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
