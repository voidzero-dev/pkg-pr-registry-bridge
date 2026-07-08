import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { isPreviewPackage } from '../preview/packages'
import { platformInfoFromName } from '../preview/platformInfo'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import {
  casKey,
  isShasum,
  metaKey,
  tarballContentUrl,
  tarballKey,
} from '../cache/r2Cache'
import { resolveVersionMeta, upsertMetaIndex } from '../preview/metaIndex'
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
): Promise<PreviewBuild & { publishedAt: string }> {
  const url = toPkgPrNewUrl(env, name, version)
  if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)

  const upstream = await fetchUpstreamTarball(url, maxTarballBytes(env))
  const build = await buildPreviewTarball(upstream, name, version, env)
  const cacheControl = tarballCacheControl()

  // Stamp the build time server-side, so the on-demand path reports the same
  // release date as a CI publish (and the same value on every later read).
  const publishedAt = new Date().toISOString()
  const meta: PreviewMeta = {
    packageJson: build.packageJson,
    shasum: build.shasum,
    integrity: build.integrity,
    publishedAt,
  }
  // Store the bytes CONTENT-ADDRESSED (keyed by this build's own shasum), so
  // the content URL the packument advertises for this build resolves to exactly
  // these bytes. A later rebuild has a different shasum -> a different cas key,
  // so the two builds' bytes coexist instead of overwriting; the meta + index
  // (last-write-wins below) just select which build the version currently
  // advertises.
  await Promise.all([
    env.STORAGE.put(casKey(name, version, build.shasum), build.tarball, {
      httpMetadata: { contentType: 'application/gzip', cacheControl },
    }),
    env.STORAGE.put(metaKey(name, version), JSON.stringify(meta), {
      httpMetadata: { contentType: 'application/json', cacheControl },
    }),
    upsertMetaIndex(env, name, version, meta),
  ])

  return { ...build, publishedAt }
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
  const cached = await env.STORAGE.get(metaKey(name, version))
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
    publishedAt: build.publishedAt,
  }
}

/**
 * The generated tarball bytes for a preview version. A content-addressed
 * request (shasum in the path) serves those exact bytes and is `immutable`
 * (the URL pins the content). A version-addressed request (old lockfile or the
 * npm-convention path) resolves the version's CURRENT build and redirects to
 * its content URL (the version->build mapping is mutable, so the caller marks
 * that redirect no-store).
 *
 * Served from R2 when present (a passthrough with a Content-Length that cannot
 * be truncated). On a miss: small preview packages are built in-Worker; platform
 * binaries (never built in-Worker) redirect to pkg.pr.new as a best-effort
 * fallback for a ref not yet published by CI. That fallback serves the original
 * upstream bytes (version 0.2.x), which npm/yarn/bun accept but pnpm's strict
 * store check rejects, so the published R2 path (where CI uploads a version-
 * matched rewrite) is the supported one; the redirect just avoids a hard 404 in
 * the gap.
 */
export type PreviewTarball =
  | {
      kind: 'body'
      body: ReadableStream<Uint8Array> | Uint8Array
      contentLength: number
      immutable: boolean
    }
  | { kind: 'redirect'; location: string }

export async function getPreviewTarballBody(
  env: Env,
  name: string,
  version: string,
  shasum?: string,
): Promise<PreviewTarball> {
  if (isShasum(shasum)) {
    // Content-addressed request: a new-action publish always has the CAS object,
    // so this is the hot path (one get) and its bytes are immutable (the URL
    // pins the exact shasum).
    const cas = await env.STORAGE.get(casKey(name, version, shasum))
    if (cas) return { kind: 'body', body: cas.body, contentLength: cas.size, immutable: true }
    // Migration fallback for an old version-addressed publish action: it stored
    // the bytes at tarballKey and published this same shasum, so serve them for
    // the CURRENT build's content URL. Gate on (meta.shasum === shasum) so a
    // request for a SUPERSEDED shasum (the meta has moved on) 404s instead of
    // getting stale bytes, and mark it NOT immutable: tarballKey is a mutable key,
    // so a revalidatable response self-heals and can't poison a cache for a year.
    // This runs only on a CAS miss (the old-action transition window or a
    // genuinely absent build); it never serves a different build's bytes as
    // immutable. The version republishes through the content path to restore the
    // CAS object and return to the hot path.
    const meta = await resolveVersionMeta(env, name, version)
    if (meta && meta.shasum === shasum) {
      const legacy = await env.STORAGE.get(tarballKey(name, version))
      if (legacy) return { kind: 'body', body: legacy.body, contentLength: legacy.size, immutable: false }
    }
    throw new HttpError(404, `No such tarball: ${name}@${version} (${shasum})`)
  }

  // Version-addressed request (old lockfile / npm-convention path): point at the
  // canonical content URL for the version's CURRENT build. The mapping is
  // mutable, so serveTarball marks the redirect no-store.
  const meta = await resolveVersionMeta(env, name, version)
  if (meta && isShasum(meta.shasum)) {
    return { kind: 'redirect', location: tarballContentUrl(env, name, version, meta.shasum) }
  }

  // No published shasum yet: serve legacy version-addressed bytes if present,
  // else (platform) redirect upstream, else build the small preview in-Worker.
  const legacy = await env.STORAGE.get(tarballKey(name, version))
  if (legacy) return { kind: 'body', body: legacy.body, contentLength: legacy.size, immutable: false }

  if (!isPreviewPackage(name)) {
    const url = toPkgPrNewUrl(env, name, version)
    if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)
    return { kind: 'redirect', location: url }
  }

  const build = await buildAndStore(env, name, version)
  return { kind: 'body', body: build.tarball, contentLength: build.tarball.byteLength, immutable: false }
}
