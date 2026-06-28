import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { isPreviewPackage } from '../preview/packages'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import { metaKey, tarballKey } from '../cache/r2Cache'
import { tarballCacheControl } from '../cache/headers'
import { rewritePackageJson } from './rewritePackageJson'
import { assertSafeTarballPath } from '../security/validateTarballPath'
import { rewriteTarballEntryStream } from './rewriteTarballStream'
import {
  buildPreviewTarball,
  encodePackageJson,
  extractRewrittenPackageJson,
  PACKAGE_JSON_NAMES,
  type PreviewBuild,
  type PreviewMeta,
} from './buildPreviewTarball'
import {
  fetchUpstreamTarball,
  fetchUpstreamTarballStream,
} from './fetchUpstreamTarball'

// R2 multipart parts must be >=5 MiB and (except the last) equal-sized.
const PART_SIZE = 10 * 1024 * 1024

/**
 * Build the rewritten tarball for a large non-preview package (a platform
 * binary) as a stream: swap only `package/package.json` and pass the multi-MB
 * native binary straight through, re-emitting gzip "stored" (uncompressed)
 * blocks. Nothing is materialized whole, so it stays within the Worker's 128MB
 * memory limit (buffering the ~tens-of-MB decompressed payload to re-tar/re-gzip
 * it returns Cloudflare 1102).
 */
async function buildPlatformTarballStream(
  env: Env,
  name: string,
  version: string,
): Promise<ReadableStream<Uint8Array>> {
  const url = toPkgPrNewUrl(env, name, version)
  if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)

  const upstream = await fetchUpstreamTarballStream(url, maxTarballBytes(env))
  return rewriteTarballEntryStream(
    upstream,
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
}

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
 * Build a platform-binary tarball into R2 via a multipart upload, then leave it
 * to be served straight from R2.
 *
 * This is the only shape that satisfies both constraints: the build STREAMS
 * (the stored-gzip consumer keeps pace with the decompressor, so the ~tens-of-MB
 * payload is never held whole, which a buffered re-tar/re-gzip would and OOM at
 * Cloudflare 1102), and the upload is chunked into bounded ~10MB parts (so it
 * never buffers the whole object the way a single put of an unsized stream
 * would). Serving the finished object from R2 is a plain byte passthrough with a
 * Content-Length, so it cannot be truncated the way a Worker-generated transform
 * response can. The work is awaited inside the handler so the Worker pumps it to
 * completion. Integrity is not pinned for these packages (see `buildMetaLight`).
 */
async function buildPlatformTarballToR2(
  env: Env,
  name: string,
  version: string,
): Promise<void> {
  const stream = await buildPlatformTarballStream(env, name, version)
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
    const reader = stream.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      pending.push(value)
      pendingLen += value.byteLength
      while (pendingLen >= PART_SIZE) {
        const merged = mergeChunks(pending, pendingLen)
        parts.push(
          await upload.uploadPart(parts.length + 1, merged.subarray(0, PART_SIZE)),
        )
        const rest = merged.slice(PART_SIZE) // copy so the 10MB buffer is freed
        pending = rest.byteLength ? [rest] : []
        pendingLen = rest.byteLength
      }
    }
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
