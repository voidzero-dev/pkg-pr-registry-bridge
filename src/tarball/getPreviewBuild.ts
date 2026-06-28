import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { isPreviewPackage } from '../preview/packages'
import { platformInfoFromName } from '../preview/platformInfo'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import { metaKey, tarballKey } from '../cache/r2Cache'
import { tarballCacheControl } from '../cache/headers'
import {
  buildPreviewTarball,
  type PreviewBuild,
  type PreviewMeta,
} from './buildPreviewTarball'
import { fetchUpstreamTarball } from './fetchUpstreamTarball'

/**
 * Build a SMALL preview package (vite-plus / core) and durably persist BOTH the
 * rewritten package.json ("meta") and the generated tarball to R2.
 *
 * This is only a fallback for a ref registered without a CI publish: normally
 * the publish action builds and uploads these. They are small (no large binary),
 * so the in-Worker rewrite/re-gzip stays well within the CPU/memory limits,
 * unlike the platform binaries (which are never built in-Worker, see below).
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
 * A platform binary's meta derived from its name (os/cpu/libc), with no
 * download. Used when a ref was registered without a CI publish, so the
 * packument still lists the binary with the right platform fields (the package
 * manager filters on these) and a tarball URL that the bridge redirects to
 * pkg.pr.new. Integrity is left empty; the package manager computes it from the
 * downloaded tarball (and CI fills in the authoritative meta when it publishes).
 */
function platformMetaFromName(name: string, version: string): PreviewMeta {
  const info = platformInfoFromName(name)
  const packageJson: Record<string, any> = { name, version }
  if (info) {
    packageJson.os = info.os
    packageJson.cpu = info.cpu
    if (info.libc) packageJson.libc = info.libc
  }
  return { packageJson, shasum: '', integrity: '' }
}

/**
 * The cached metadata (rewritten package.json + integrity) for a preview
 * version, served from R2 when present. This is the cheap artifact the
 * packument endpoint needs. On a miss it falls back without any large in-Worker
 * work: small preview packages are built once and cached; platform binaries get
 * a name-derived meta (no download).
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

  if (!isPreviewPackage(name)) return platformMetaFromName(name, version)

  const build = await buildAndStore(env, name, version)
  return {
    packageJson: build.packageJson,
    shasum: build.shasum,
    integrity: build.integrity,
  }
}

/**
 * The generated tarball bytes for a preview version. Served from R2 when
 * present (a passthrough with a Content-Length that cannot be truncated). On a
 * miss: small preview packages are built in-Worker; platform binaries (never
 * built in-Worker) redirect to pkg.pr.new as a best-effort fallback for a ref
 * not yet published by CI. That fallback serves the original upstream bytes
 * (version 0.2.x), which npm/yarn/bun accept but pnpm's strict store check
 * rejects, so the published R2 path (where CI uploads a version-matched rewrite)
 * is the supported one; the redirect just avoids a hard 404 in the gap.
 */
export type PreviewTarball =
  | { kind: 'body'; body: ReadableStream<Uint8Array> | Uint8Array; contentLength?: number }
  | { kind: 'redirect'; location: string }

export async function getPreviewTarballBody(
  env: Env,
  name: string,
  version: string,
): Promise<PreviewTarball> {
  const cached = await env.TARBALL_CACHE.get(tarballKey(name, version))
  if (cached) {
    return { kind: 'body', body: cached.body, contentLength: cached.size }
  }

  if (!isPreviewPackage(name)) {
    const url = toPkgPrNewUrl(env, name, version)
    if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)
    return { kind: 'redirect', location: url }
  }

  const tarball = (await buildAndStore(env, name, version)).tarball
  return { kind: 'body', body: tarball, contentLength: tarball.byteLength }
}
