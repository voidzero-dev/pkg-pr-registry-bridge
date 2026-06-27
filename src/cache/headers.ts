const SHORT_MAX_AGE = 'public, max-age=300'
const IMMUTABLE_MAX_AGE = 'public, max-age=31536000, immutable'

/**
 * Cache policy for a tarball. Only immutable commit builds are served, so the
 * content for a given (name, version) never changes.
 */
export function tarballCacheControl(_version: string): string {
  return IMMUTABLE_MAX_AGE
}

/**
 * Cache policy for a packument. Kept short-lived because the set of injected
 * refs can change at runtime (admin/webhook) and the merged npm versions move.
 */
export function packumentCacheControl(): string {
  return SHORT_MAX_AGE
}
