import { isWorkspacePackage, PREVIEW_PACKAGES } from '../preview/packages'
import { commitVersion } from '../preview/parsePreviewVersion'

/** Config needed to rebuild pkg.pr.new URLs as bridge URLs. */
export interface RewriteEnv {
  PUBLIC_BASE_URL: string
  PKG_PR_NEW_BASE: string
  PREVIEW_OWNER: string
  PREVIEW_REPO: string
  WORKSPACE_PACKAGES: string
}

function refToVersion(ref: string): string | null {
  // Only immutable commit refs are routed through the bridge. A PR-number URL
  // (a mutable ref) is left as the original direct pkg.pr.new URL.
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return commitVersion(ref)
  return null
}

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
  const prefix = `${env.PKG_PR_NEW_BASE}/${env.PREVIEW_OWNER}/${env.PREVIEW_REPO}/`
  if (!spec.startsWith(prefix)) return null
  const rest = spec.slice(prefix.length)
  const at = rest.lastIndexOf('@')
  if (at <= 0) return null
  const name = rest.slice(0, at)
  // Only route packages the bridge will serve; otherwise leave the working
  // direct pkg.pr.new URL in place.
  if (!isWorkspacePackage(name, env)) return null
  return refToVersion(rest.slice(at + 1))
}

/**
 * Rewrite a dependency map:
 *  - preview packages (vite-plus, core) -> the synthetic preview version,
 *  - direct pkg.pr.new URLs -> the synthetic version string for that ref,
 *  - everything else -> unchanged.
 */
function rewriteDependencies(
  deps: Record<string, string> | undefined,
  version: string,
  env: RewriteEnv,
): Record<string, string> | undefined {
  if (!deps) return deps
  const next = { ...deps }
  for (const [name, spec] of Object.entries(deps)) {
    if (PREVIEW_PACKAGES.has(name)) {
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
 * set name/version and rewrite preview/pkg.pr.new dependencies. The package is
 * NOT renamed to `vite` (npm alias semantics handle that in the consumer's
 * dependency spec).
 */
export function rewritePackageJson(
  pkg: Record<string, any>,
  packageName: string,
  version: string,
  env: RewriteEnv,
): Record<string, any> {
  const next: Record<string, any> = { ...pkg }
  next.name = packageName
  next.version = version

  if (next.dependencies) {
    next.dependencies = rewriteDependencies(next.dependencies, version, env)
  }
  if (next.peerDependencies) {
    next.peerDependencies = rewriteDependencies(next.peerDependencies, version, env)
  }
  if (next.optionalDependencies) {
    next.optionalDependencies = rewriteDependencies(
      next.optionalDependencies,
      version,
      env,
    )
  }

  return next
}
