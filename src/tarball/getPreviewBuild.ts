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
 * Stream a large non-preview tarball (a platform binary): swap only
 * `package/package.json` and pass the multi-MB native binary straight through.
 *
 * The payload is never materialized whole, not even to store it: a Worker
 * cannot hold a ~tens-of-MB decompressed binary plus the working set within the
 * 128MB memory limit (cold builds return Cloudflare 1102; CPU is not the
 * constraint, re-gzip is ~700ms). So this returns a stream piped straight to the
 * client and does NOT cache to R2 (which would require buffering the whole
 * payload to get a known length). Integrity is not pinned for these packages
 * (see `buildMetaLight`), so the package manager computes it from the bytes it
 * downloads, and the output uses gzip "stored" blocks (no recompression).
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
    const rewritten = rewritePackageJson(pkg, name, version, env)
    return new TextEncoder().encode(`${JSON.stringify(rewritten, null, 2)}\n`)
  }

  return rewriteTarballEntryStream(
    upstream,
    PACKAGE_JSON_NAMES,
    rewrite,
    assertSafeTarballPath,
  )
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
export async function getPreviewTarballBody(
  env: Env,
  name: string,
  version: string,
): Promise<ReadableStream<Uint8Array> | Uint8Array> {
  // Serve a cached build by streaming it from R2 (bounded memory; the cached
  // platform binaries are tens of MB).
  const cached = await env.TARBALL_CACHE.get(tarballKey(name, version))
  if (cached) return cached.body

  // Large platform binaries decompress to tens of MB; buffering them to re-tar,
  // re-gzip, or even to store exceeds the Worker memory budget (Cloudflare
  // 1102). Stream those straight to the client instead (no R2 cache). The small
  // preview packages (which also pin integrity) keep the buffered+cached path.
  if (!isPreviewPackage(name)) {
    return buildPlatformTarballStream(env, name, version)
  }
  return (await buildAndStore(env, name, version)).tarball
}
