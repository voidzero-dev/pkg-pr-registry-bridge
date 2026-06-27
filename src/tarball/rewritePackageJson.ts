import { isWorkspacePackage, PREVIEW_PACKAGES } from '../preview/packages'

/** Config needed to rebuild pkg.pr.new URLs as bridge URLs. */
export interface RewriteEnv {
  PUBLIC_BASE_URL: string
  PKG_PR_NEW_BASE: string
  PREVIEW_OWNER: string
  PREVIEW_REPO: string
  WORKSPACE_PACKAGES: string
}

function refToVersion(ref: string): string | null {
  if (/^\d+$/.test(ref)) return `0.0.0-pr.${ref}`
  if (/^[0-9a-f]{7,40}$/i.test(ref)) return `0.0.0-commit.${ref}`
  return null
}

/**
 * Rewrite a direct pkg.pr.new dependency URL for the configured repo into the
 * equivalent bridge tarball URL, so transitive preview deps (e.g. the platform
 * binaries in `optionalDependencies`) are served and cached by the bridge
 * instead of fetched straight from pkg.pr.new. Returns null when the spec is
 * not such a URL.
 */
export function rewritePkgPrNewUrl(
  spec: string,
  env: RewriteEnv,
): string | null {
  const prefix = `${env.PKG_PR_NEW_BASE}/${env.PREVIEW_OWNER}/${env.PREVIEW_REPO}/`
  if (!spec.startsWith(prefix)) return null
  const rest = spec.slice(prefix.length)
  const at = rest.lastIndexOf('@')
  if (at <= 0) return null
  const name = rest.slice(0, at)
  // Only route packages the tarball endpoint will actually serve; otherwise
  // leave the working direct pkg.pr.new URL in place.
  if (!isWorkspacePackage(name, env)) return null
  const version = refToVersion(rest.slice(at + 1))
  if (!version) return null
  return `${env.PUBLIC_BASE_URL}/tarballs/${name}/${version}.tgz`
}

/**
 * Rewrite a dependency map:
 *  - preview packages (vite-plus, core) -> the synthetic preview version,
 *  - direct pkg.pr.new URLs -> bridge tarball URLs,
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
    const url = rewritePkgPrNewUrl(spec, env)
    if (url) next[name] = url
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
