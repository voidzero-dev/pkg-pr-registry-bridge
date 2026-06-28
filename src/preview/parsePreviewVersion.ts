/**
 * Strict parser for synthetic preview versions.
 *
 *   0.0.0-commit.<sha>     -> pkg.pr.new commit build
 *
 * Only immutable commit builds are supported. PR-number versions
 * (`0.0.0-pr.<n>`) are intentionally NOT accepted: a PR ref is mutable (it
 * moves to newer commits), so its generated metadata/tarball would be
 * overwritten over time and could mismatch what a consumer already pinned in a
 * lockfile. Pinning a commit sha keeps the content immutable.
 *
 * Any other semver or dist-tag routes to npm.
 */
export type PreviewRef = { type: 'commit'; ref: string }

/** Build the synthetic version for a commit sha (the inverse of the parse). */
export function commitVersion(sha: string): string {
  return `0.0.0-commit.${sha}`
}

export function parsePreviewVersion(version: string): PreviewRef | null {
  const commit = version.match(/^0\.0\.0-commit\.([0-9a-f]{7,40})$/i)
  if (commit) return { type: 'commit', ref: commit[1] }
  return null
}

export function isPreviewVersion(version: string): boolean {
  return parsePreviewVersion(version) !== null
}
