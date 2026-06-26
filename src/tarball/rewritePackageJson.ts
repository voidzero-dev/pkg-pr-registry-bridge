import { PREVIEW_PACKAGES } from '../preview/packages'

/**
 * Rewrite preview-package dependency specs to the synthetic version so the
 * whole preview dependency graph resolves through the bridge.
 */
export function rewritePreviewDependencies(
  deps: Record<string, string> | undefined,
  version: string,
): Record<string, string> | undefined {
  if (!deps) return deps
  const next = { ...deps }
  for (const name of PREVIEW_PACKAGES) {
    if (name in next) next[name] = version
  }
  return next
}

/**
 * Rewrite an upstream `package/package.json` for the synthetic preview release:
 * set name/version and rewrite preview deps. The package is NOT renamed to
 * `vite` (npm alias semantics handle that in the consumer's dependency spec).
 */
export function rewritePackageJson(
  pkg: Record<string, any>,
  packageName: string,
  version: string,
): Record<string, any> {
  const next: Record<string, any> = { ...pkg }
  next.name = packageName
  next.version = version

  if (next.dependencies) {
    next.dependencies = rewritePreviewDependencies(next.dependencies, version)
  }
  if (next.peerDependencies) {
    next.peerDependencies = rewritePreviewDependencies(
      next.peerDependencies,
      version,
    )
  }
  if (next.optionalDependencies) {
    next.optionalDependencies = rewritePreviewDependencies(
      next.optionalDependencies,
      version,
    )
  }

  return next
}
