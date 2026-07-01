import type { Env } from '../config'
import { META_PREFIX, TARBALL_PREFIX } from '../cache/r2Cache'
import { REF_TTL_MS } from './getConfiguredRefs'

// The per-version artifact prefixes (shared with the key builders). NOT
// `meta-index/` or `refs/`: those are the live indexes (self-pruned on write),
// not per-version orphans, and their prefixes are disjoint from these.
const ARTIFACT_PREFIXES = [META_PREFIX, TARBALL_PREFIX]

/**
 * Delete per-version preview artifacts (meta + tarball) whose ref TTL has lapsed,
 * so R2 storage stays bounded to the active-ref window rather than growing with
 * every ref ever published.
 *
 * A ref's objects are (re-)uploaded on each publish, so an object's `uploaded`
 * age equals its ref's age, and the ref TTL maps exactly to
 * `uploaded < now - REF_TTL_MS`. An active ref (published within the window) is
 * therefore never touched; an expired ref's objects, which are no longer served
 * (the packument skips expired refs), are the orphans this removes. `now` is
 * injectable for tests.
 */
export async function cleanupExpiredArtifacts(
  env: Pick<Env, 'STORAGE'>,
  now: number = Date.now(),
): Promise<{ deleted: number }> {
  const cutoff = now - REF_TTL_MS
  let deleted = 0
  for (const prefix of ARTIFACT_PREFIXES) {
    let cursor: string | undefined
    do {
      const listing = await env.STORAGE.list({ prefix, cursor })
      const expired = listing.objects
        .filter((o) => o.uploaded.getTime() < cutoff)
        .map((o) => o.key)
      if (expired.length > 0) {
        // R2 bulk delete takes up to 1000 keys; a list page is <= 1000.
        await env.STORAGE.delete(expired)
        deleted += expired.length
      }
      cursor = listing.truncated ? listing.cursor : undefined
    } while (cursor)
  }
  return { deleted }
}
