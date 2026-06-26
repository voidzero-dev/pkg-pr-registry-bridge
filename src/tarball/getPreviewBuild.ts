import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { parsePreviewVersion } from '../preview/parsePreviewVersion'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import { metaKey, tarballKey } from '../cache/r2Cache'
import { buildPreviewTarball, type PreviewBuild } from './buildPreviewTarball'
import { fetchUpstreamTarball } from './fetchUpstreamTarball'

function cacheControlFor(version: string): string {
  return parsePreviewVersion(version)?.type === 'commit'
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=300'
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
  const build = await buildPreviewTarball(upstream, name, version)
  const cacheControl = cacheControlFor(version)

  await Promise.all([
    env.TARBALL_CACHE.put(tarballKey(name, version), build.tarball, {
      httpMetadata: { contentType: 'application/gzip', cacheControl },
    }),
    env.TARBALL_CACHE.put(
      metaKey(name, version),
      JSON.stringify(build.packageJson),
      { httpMetadata: { contentType: 'application/json', cacheControl } },
    ),
  ])

  return build
}

/**
 * The rewritten package.json for a preview version, served from R2 when
 * present. This is the cheap artifact the packument endpoint needs (no tarball
 * download, no gzip) once the build has been cached.
 */
export async function getPreviewMeta(
  env: Env,
  name: string,
  version: string,
): Promise<Record<string, any>> {
  const cached = await env.TARBALL_CACHE.get(metaKey(name, version))
  console.log(`getMeta ${name}@${version} key=${metaKey(name, version)} hit=${!!cached}`)
  if (cached) return cached.json<Record<string, any>>()
  const build = await buildAndStore(env, name, version)
  return build.packageJson
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
  const build = await buildAndStore(env, name, version)
  return build.tarball
}
