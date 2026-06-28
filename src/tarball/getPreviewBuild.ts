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

/**
 * Build the rewritten tarball for a large non-preview package (a platform
 * binary) as a stream: swap only `package/package.json` and pass the multi-MB
 * native binary straight through, re-emitting gzip "stored" (uncompressed)
 * blocks. Nothing is materialized whole, so it stays within the Worker's 128MB
 * memory limit (buffering the ~tens-of-MB decompressed payload to re-tar/re-gzip
 * it returns Cloudflare 1102). A fresh upstream fetch is started per call so the
 * stream can be (re)built for the two-pass store below.
 */
async function buildPlatformTarballStream(
  env: Env,
  name: string,
  version: string,
): Promise<ReadableStream<Uint8Array>> {
  const url = toPkgPrNewUrl(env, name, version)
  if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)

  const upstream = await fetchUpstreamTarballStream(url, maxTarballBytes(env))
  const rewrite = (data: Uint8Array): Uint8Array => {
    let pkg: Record<string, any>
    try {
      pkg = JSON.parse(new TextDecoder().decode(data))
    } catch {
      throw new HttpError(422, 'Invalid package/package.json in upstream tarball')
    }
    return encodePackageJson(rewritePackageJson(pkg, name, version, env))
  }

  return rewriteTarballEntryStream(
    upstream,
    PACKAGE_JSON_NAMES,
    rewrite,
    assertSafeTarballPath,
  )
}

/**
 * Build a platform-binary tarball and persist it to R2 without ever holding it
 * whole. Streaming the rewrite to the client directly turned out to truncate
 * (a Worker response stream produced by post-handler transform work gets cut,
 * and the client's strict gunzip then fails with "unexpected end of file"). So
 * instead we build it INTO R2 while the handler is still running and awaiting
 * (the Worker actively pumps it to completion), then serve it from R2, which is
 * a plain byte passthrough that streams large objects reliably with a
 * Content-Length.
 *
 * R2 needs a known length to store a stream, so this makes two streaming passes:
 * one to measure the exact output length, one to write it through a
 * `FixedLengthStream`. Both passes are bounded (the stored-gzip consumer keeps
 * pace with the decompressor, so the payload never accumulates). Deterministic
 * stored-gzip output makes the two passes' lengths identical.
 */
async function buildAndStorePlatformTarball(
  env: Env,
  name: string,
  version: string,
): Promise<void> {
  // Pass 1: measure the exact output length (stream and discard).
  let length = 0
  const reader = (await buildPlatformTarballStream(env, name, version)).getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
    }
  } finally {
    reader.releaseLock()
  }

  // Pass 2: stream the same bytes into R2 with the now-known length.
  const fixed = new FixedLengthStream(length)
  const source = await buildPlatformTarballStream(env, name, version)
  const pumped = source.pipeTo(fixed.writable)
  await env.TARBALL_CACHE.put(tarballKey(name, version), fixed.readable, {
    httpMetadata: {
      contentType: 'application/gzip',
      cacheControl: tarballCacheControl(),
    },
  })
  await pumped
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
export interface PreviewTarballBody {
  body: ReadableStream<Uint8Array> | Uint8Array
  /** Set when the size is known up front, so the response carries a
   * Content-Length and clients can detect a truncated transfer. */
  contentLength?: number
}

export async function getPreviewTarballBody(
  env: Env,
  name: string,
  version: string,
): Promise<PreviewTarballBody> {
  let cached = await env.TARBALL_CACHE.get(tarballKey(name, version))

  // Large platform binaries decompress to tens of MB; buffering them to re-tar
  // or re-gzip exceeds the Worker memory budget (Cloudflare 1102), and streaming
  // the transform straight to the client truncates. Build them into R2 first
  // (see buildAndStorePlatformTarball), then serve from R2 below.
  if (!cached && !isPreviewPackage(name)) {
    await buildAndStorePlatformTarball(env, name, version)
    cached = await env.TARBALL_CACHE.get(tarballKey(name, version))
    if (!cached) throw new HttpError(500, 'Failed to persist generated tarball')
  }

  // Serve a cached build straight from R2: a plain byte passthrough with a
  // Content-Length, which streams large objects reliably.
  if (cached) return { body: cached.body, contentLength: cached.size }

  // Small preview packages keep the buffered+cached+integrity path.
  return { body: (await buildAndStore(env, name, version)).tarball }
}
