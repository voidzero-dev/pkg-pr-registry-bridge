/**
 * The manifest fields whose dependency specs are rewritten, and that the
 * publish action's batch validation checks. One home for this knowledge so
 * the up-front check can never drift from what actually gets pinned.
 */
export const DEPENDENCY_FIELDS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
] as const

/**
 * Rewrite a dependency map: packages publishing together as this synthetic
 * version (`pinned`) are set to the synthetic preview version; everything else
 * is left unchanged.
 */
function rewriteDependencies(
  deps: Record<string, string> | undefined,
  version: string,
  pinned: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (!deps) return deps
  const next = { ...deps }
  for (const name of Object.keys(deps)) {
    if (pinned.has(name)) next[name] = version
  }
  return next
}

/**
 * Rewrite an upstream `package/package.json` for the synthetic preview release:
 * set name/version and pin deps between packages of the same publish batch to
 * the synthetic version. The publish action passes the names it is publishing
 * together (`batch`), whose validation guarantees every workspace dep is
 * covered. The package is NOT renamed to `vite` (npm alias semantics handle
 * that in the consumer's dependency spec).
 */
export function rewritePackageJson(
  pkg: Record<string, any>,
  packageName: string,
  version: string,
  batch: ReadonlySet<string>,
): Record<string, any> {
  const next: Record<string, any> = { ...pkg }
  next.name = packageName
  next.version = version

  for (const field of DEPENDENCY_FIELDS) {
    if (next[field]) {
      next[field] = rewriteDependencies(next[field], version, batch)
    }
  }

  return next
}
