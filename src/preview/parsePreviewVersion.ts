/**
 * Strict parser for synthetic preview versions.
 *
 *   0.0.0-pr.<number>      -> pkg.pr.new PR build
 *   0.0.0-commit.<sha>     -> pkg.pr.new commit build
 *
 * Any other semver or dist-tag is not a preview version and routes to npm.
 */
export type PreviewRef =
  | { type: 'pr'; ref: string }
  | { type: 'commit'; ref: string }

export function parsePreviewVersion(version: string): PreviewRef | null {
  const pr = version.match(/^0\.0\.0-pr\.(\d+)$/)
  if (pr) return { type: 'pr', ref: pr[1] }

  const commit = version.match(/^0\.0\.0-commit\.([0-9a-f]{7,40})$/i)
  if (commit) return { type: 'commit', ref: commit[1] }

  return null
}

export function isPreviewVersion(version: string): boolean {
  return parsePreviewVersion(version) !== null
}
