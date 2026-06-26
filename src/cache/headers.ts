import type { ConfiguredPreviewRef } from '../preview/parseConfiguredPreviewRefs'
import { parsePreviewVersion } from '../preview/parsePreviewVersion'

const PR_MAX_AGE = 'public, max-age=300'
const COMMIT_MAX_AGE = 'public, max-age=31536000, immutable'

/**
 * Cache policy for a tarball: commit refs are immutable, PR refs are short
 * lived because a PR number may point to newer commits over time.
 */
export function tarballCacheControl(version: string): string {
  return parsePreviewVersion(version)?.type === 'commit'
    ? COMMIT_MAX_AGE
    : PR_MAX_AGE
}

/**
 * Cache policy for a packument: if any injected ref is a (mutable) PR ref, keep
 * it short lived; an all-commit configuration can be cached longer.
 */
export function packumentCacheControl(refs: ConfiguredPreviewRef[]): string {
  const hasPr = refs.length === 0 || refs.some((r) => r.type === 'pr')
  return hasPr ? PR_MAX_AGE : 'public, max-age=3600'
}
