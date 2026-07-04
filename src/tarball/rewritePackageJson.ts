import { isWorkspacePackage, PREVIEW_PACKAGES } from '../preview/packages'
import { shaToVersion } from '../preview/parsePreviewVersion'

/**
 * Config needed to rewrite preview manifests. The pkg.pr.new fields only
 * matter on the Worker's fallback path, which rebuilds upstream tarballs
 * whose deps are pkg.pr.new URLs; the publish action packs local directories
 * (whose manifests never contain such URLs) and omits them.
 */
export interface RewriteEnv {
  PUBLIC_BASE_URL: string
  PKG_PR_NEW_BASE?: string
  PREVIEW_OWNER?: string
  PREVIEW_REPO?: string
  WORKSPACE_PACKAGES: string
}

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
 * Convert a direct pkg.pr.new dependency URL for the configured repo into the
 * equivalent synthetic version string (e.g. `0.0.0-commit.<sha>`), so
 * transitive preview deps (e.g. the platform binaries in
 * `optionalDependencies`) resolve through the bridge registry like the other
 * preview packages, rather than as raw tarball URLs. A version string also lets
 * the package manager filter platforms from the packument and download only the
 * matching binary. Returns null when the spec is not such a URL.
 */
export function pkgPrNewUrlToVersion(
  spec: string,
  env: RewriteEnv,
): string | null {
  if (!env.PKG_PR_NEW_BASE || !env.PREVIEW_OWNER || !env.PREVIEW_REPO) {
    return null
  }
  const prefix = `${env.PKG_PR_NEW_BASE}/${env.PREVIEW_OWNER}/${env.PREVIEW_REPO}/`
  if (!spec.startsWith(prefix)) return null
  const rest = spec.slice(prefix.length)
  const at = rest.lastIndexOf('@')
  if (at <= 0) return null
  const name = rest.slice(0, at)
  // Only route packages the bridge will serve; otherwise leave the working
  // direct pkg.pr.new URL in place. A non-commit (e.g. PR-number) ref is mutable
  // and likewise left as the original direct URL (shaToVersion returns null).
  if (!isWorkspacePackage(name, env)) return null
  return shaToVersion(rest.slice(at + 1))
}

/**
 * Rewrite a dependency map:
 *  - packages publishing together as this synthetic version (`pinned`) -> the
 *    synthetic preview version,
 *  - direct pkg.pr.new URLs -> the synthetic version string for that ref,
 *  - everything else -> unchanged.
 */
function rewriteDependencies(
  deps: Record<string, string> | undefined,
  version: string,
  env: RewriteEnv,
  pinned: ReadonlySet<string>,
): Record<string, string> | undefined {
  if (!deps) return deps
  const next = { ...deps }
  for (const [name, spec] of Object.entries(deps)) {
    if (pinned.has(name)) {
      next[name] = version
      continue
    }
    const refVersion = pkgPrNewUrlToVersion(spec, env)
    if (refVersion) next[name] = refVersion
  }
  return next
}

/**
 * Rewrite an upstream `package/package.json` for the synthetic preview release:
 * set name/version and rewrite preview/pkg.pr.new dependencies. Deps on `batch`
 * members are pinned to the synthetic version: the publish action passes the
 * names it is publishing together (whose validation guarantees every workspace
 * dep is covered); the Worker's fallback path passes nothing and pins the
 * preview packages, its implicit batch (platform-binary deps arrive there as
 * pkg.pr.new URLs instead). The package is NOT renamed to `vite` (npm alias
 * semantics handle that in the consumer's dependency spec).
 */
export function rewritePackageJson(
  pkg: Record<string, any>,
  packageName: string,
  version: string,
  env: RewriteEnv,
  batch?: ReadonlySet<string>,
): Record<string, any> {
  const pinned = batch ?? PREVIEW_PACKAGES
  const next: Record<string, any> = { ...pkg }
  next.name = packageName
  next.version = version

  for (const field of DEPENDENCY_FIELDS) {
    if (next[field]) {
      next[field] = rewriteDependencies(next[field], version, env, pinned)
    }
  }

  return next
}
