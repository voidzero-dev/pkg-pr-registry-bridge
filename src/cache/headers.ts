const SHORT_MAX_AGE = 'public, max-age=300'
const IMMUTABLE_MAX_AGE = 'public, max-age=31536000, immutable'

/**
 * Cache policy for a tarball. Only immutable commit builds are served, so the
 * content for a given (name, version) never changes.
 */
export function tarballCacheControl(): string {
  return IMMUTABLE_MAX_AGE
}

/**
 * Cache policy for a packument. Kept short-lived because the set of injected
 * refs can change at runtime (admin/publish) and the merged npm versions move.
 */
export function packumentCacheControl(): string {
  return SHORT_MAX_AGE
}

/**
 * Cache policy for the cached npm `time` map. Short for its OWN reason, bounding
 * how long a brand-new npm version's time lags, which is independent of the
 * packument TTL even though they currently share a value.
 */
export function npmTimeCacheControl(): string {
  return SHORT_MAX_AGE
}
