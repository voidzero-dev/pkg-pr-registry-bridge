import type { Env } from '../config'
import { HttpError } from '../httpError'
import { casKey, isShasum, metaKey, tarballContentUrl, tarballKey } from '../cache/r2Cache'
import { r2Get } from '../cache/r2Get'
import { resolveVersionMeta } from '../preview/metaIndex'
import type { PreviewMeta } from './buildPreviewTarball'

/**
 * The published metadata (rewritten package.json + integrity) for a preview
 * version, read from R2. R2 is the single source of truth: CI publishes every
 * package's meta (`POST /-/publish`) before registering its ref, so a registered
 * ref always has its meta stored. A miss means the version was never published
 * (or was purged); there is no on-demand build, so surface a 404 and let the
 * packument assembly skip the version.
 */
export async function getPreviewMeta(
  env: Env,
  name: string,
  version: string,
): Promise<PreviewMeta> {
  const cached = await r2Get(env, metaKey(name, version))
  if (!cached) {
    throw new HttpError(404, `No published metadata: ${name}@${version}`)
  }
  const stored = await cached.json<Record<string, any>>()
  // Tolerate the pre-integrity meta format (a bare package.json object).
  if (stored && typeof stored === 'object' && 'packageJson' in stored) {
    return stored as PreviewMeta
  }
  return { packageJson: stored, shasum: '', integrity: '' }
}

/**
 * The generated tarball bytes for a preview version, served from R2 (the single
 * source of truth). A content-addressed request (shasum in the path) serves
 * those exact bytes and is `immutable` (the URL pins the content). A version-
 * addressed request (old lockfile or the npm-convention path) resolves the
 * version's CURRENT build and redirects to its content URL (the version->build
 * mapping is mutable, so the caller marks that redirect no-store).
 *
 * CI uploads every tarball before registering the ref, so a registered version
 * always has its bytes in R2; a genuine miss is a 404. The Worker never builds a
 * tarball on demand and never redirects upstream.
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
    // Content-addressed request: a publish always has the CAS object, so this is
    // the hot path (one get) and its bytes are immutable (the URL pins the exact
    // shasum).
    const cas = await r2Get(env, casKey(name, version, shasum))
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
      const legacy = await r2Get(env, tarballKey(name, version))
      if (legacy)
        return { kind: 'body', body: legacy.body, contentLength: legacy.size, immutable: false }
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
  // else 404 (nothing published for this version).
  const legacy = await r2Get(env, tarballKey(name, version))
  if (legacy)
    return { kind: 'body', body: legacy.body, contentLength: legacy.size, immutable: false }

  throw new HttpError(404, `No such tarball: ${name}@${version}`)
}
