import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { isPreviewPackage } from '../preview/packages'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import { metaKey, tarballKey } from '../cache/r2Cache'
import { tarballCacheControl } from '../cache/headers'
import { rewritePackageJson } from './rewritePackageJson'
import { assertSafeTarballPath } from '../security/validateTarballPath'
import { rewriteTarEntryInPlace } from './rewriteTarballBuffer'
import {
  buildPreviewTarball,
  encodePackageJson,
  extractRewrittenPackageJson,
  PACKAGE_JSON_NAMES,
  type PreviewBuild,
  type PreviewMeta,
} from './buildPreviewTarball'
import { fetchUpstreamTarball } from './fetchUpstreamTarball'

/**
 * Decompress a gzipped tar into a single right-sized buffer. The buffer is
 * presized from the gzip ISIZE trailer (decompressed length, valid for the
 * <4GB single-member tarballs npm produces) so there is no doubling from a
 * growing collector. The compressed input goes out of scope on return.
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
  return pos === isize ? out : out.subarray(0, pos)
}

/**
 * Build a large non-preview tarball (a platform binary) as a complete buffer.
 *
 * Earlier attempts failed two ways: buffering the decompressed payload AND a
 * re-tarred copy exceeded the 128MB Worker limit (Cloudflare 1102), while
 * streaming the rewrite straight to the client truncated (a strict client
 * gunzip then fails with "unexpected end of file"). This decompresses ONCE into
 * a single buffer, rewrites `package/package.json` IN PLACE (no second copy of
 * the ~48MB binary), then recompresses to a normal-size gzip. Returning a
 * complete buffer means the response carries a Content-Length and is never
 * truncated. Integrity is not pinned for these packages (see `buildMetaLight`).
 */
async function buildPlatformTarball(
  env: Env,
  name: string,
  version: string,
): Promise<Uint8Array> {
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

  const tarball = new Uint8Array(
    await new Response(
      new Response(tar).body!.pipeThrough(new CompressionStream('gzip')),
    ).arrayBuffer(),
  )

  await env.TARBALL_CACHE.put(tarballKey(name, version), tarball, {
    httpMetadata: {
      contentType: 'application/gzip',
      cacheControl: tarballCacheControl(),
    },
  })
  return tarball
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
  // Serve a cached build straight from R2: a plain byte passthrough with a
  // Content-Length, which streams large objects reliably.
  const cached = await env.TARBALL_CACHE.get(tarballKey(name, version))
  if (cached) return { body: cached.body, contentLength: cached.size }

  // Platform binaries: build as a complete buffer (rewrite package.json in
  // place, no second copy of the binary) and return it whole, so the response
  // carries a Content-Length and is never truncated.
  if (!isPreviewPackage(name)) {
    const tarball = await buildPlatformTarball(env, name, version)
    return { body: tarball, contentLength: tarball.byteLength }
  }

  // Small preview packages keep the buffered+cached+integrity path.
  const tarball = (await buildAndStore(env, name, version)).tarball
  return { body: tarball, contentLength: tarball.byteLength }
}
