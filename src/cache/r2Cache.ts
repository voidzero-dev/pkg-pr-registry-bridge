/** R2 object keys and the public URL for a generated preview build. */
import type { Env } from '../config'

// Per-version object key prefixes. Shared with the expiry sweep
// (cleanupExpiredArtifacts), so a rename here can't silently desync it.
export const TARBALL_PREFIX = 'tarball/'
export const META_PREFIX = 'meta/'
// Content-addressed bytes prefix (bytes keyed by their own sha1, see casKey).
export const CAS_PREFIX = 'cas/'

export function tarballKey(name: string, version: string): string {
  return `${TARBALL_PREFIX}${name}/${version}.tgz`
}

/**
 * Content-addressed tarball key: bytes keyed by their own sha1 (dist.shasum),
 * so two distinct builds of a version never overwrite each other. A republish
 * with different bytes lands at a different key and both coexist. The version
 * sits in the key (mirroring the content URL) so every build of a version is
 * listable under one prefix, which is what `/-/purge` enumerates.
 */
export function casKey(name: string, version: string, shasum: string): string {
  return `${CAS_PREFIX}${name}/${version}/${shasum}.tgz`
}

/**
 * The prefix covering EVERY content-addressed build of a version, so `/-/purge`
 * can list and delete them all (not just the current shasum). Mirrors the
 * `casKey` layout with the trailing `<shasum>.tgz` dropped.
 */
export function casVersionPrefix(name: string, version: string): string {
  return `${CAS_PREFIX}${name}/${version}/`
}

/** A valid dist.shasum (sha1 hex) — the content id in a content-addressed URL/key. */
export function isShasum(s: string | undefined): s is string {
  return !!s && /^[0-9a-f]{40}$/.test(s)
}

/** Public URL of a preview tarball (the inverse of parseTarballPath). */
export function tarballUrl(
  env: Pick<Env, 'PUBLIC_BASE_URL'>,
  name: string,
  version: string,
): string {
  return `${env.PUBLIC_BASE_URL}/tarballs/${name}/${version}.tgz`
}

/**
 * Content-addressed public URL. A re-published build has a different shasum ->
 * a different URL, so a client fetches the exact build its packument advertised
 * and `immutable` caching is always correct.
 */
export function tarballContentUrl(
  env: Pick<Env, 'PUBLIC_BASE_URL'>,
  name: string,
  version: string,
  shasum: string,
): string {
  return `${env.PUBLIC_BASE_URL}/tarballs/${name}/${version}/${shasum}.tgz`
}

export function metaKey(name: string, version: string): string {
  return `${META_PREFIX}${name}/${version}.json`
}

/**
 * Per-package aggregate of every active version's meta (`version -> meta`), so
 * the packument reads ONE object instead of one `metaKey` per configured ref.
 * Keeps the packument rebuild's subrequest count flat as refs accumulate.
 */
export function metaIndexKey(name: string): string {
  return `meta-index/${name}.json`
}

/**
 * The single object holding the runtime-registered preview refs. Read on every
 * packument request (a cheap R2 get, not a KV list, which is rate-limited).
 */
export const REFS_INDEX_KEY = 'refs/index.json'
