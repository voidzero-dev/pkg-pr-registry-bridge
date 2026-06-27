import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { isPreviewPackage } from '../preview/packages'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import { metaKey, tarballKey } from '../cache/r2Cache'
import { tarballCacheControl } from '../cache/headers'
import {
  buildPreviewTarball,
  extractRewrittenPackageJson,
  type PreviewBuild,
  type PreviewMeta,
} from './buildPreviewTarball'
import { fetchUpstreamTarball } from './fetchUpstreamTarball'

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
export async function getPreviewTarball(
  env: Env,
  name: string,
  version: string,
): Promise<Uint8Array> {
  const cached = await env.TARBALL_CACHE.get(tarballKey(name, version))
  if (cached) return new Uint8Array(await cached.arrayBuffer())
  return (await buildAndStore(env, name, version)).tarball
}
