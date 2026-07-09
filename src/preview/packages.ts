/**
 * Strict allowlist of packages that may receive synthetic preview versions.
 * Everything else is proxied to npm unchanged. The bridge must never become a
 * generic arbitrary-URL proxy.
 */
export const PREVIEW_PACKAGES = new Set<string>([
  '@voidzero-dev/vite-plus-core',
  'vite-plus',
])

export function isPreviewPackage(name: string): boolean {
  return PREVIEW_PACKAGES.has(name)
}

/**
 * Packages the tarball endpoint may serve. Broader than PREVIEW_PACKAGES: it
 * also covers the repo's other workspace artifacts (e.g. the platform binaries).
 *
 * Driven by the `WORKSPACE_PACKAGES` config (comma-separated exact names or
 * `prefix*` patterns) so new packages need no code change. A name outside the
 * allowlist 404s at the tarball endpoint. Only PREVIEW_PACKAGES get synthetic
 * versions injected into packuments.
 */
export function isWorkspacePackage(
  name: string,
  env: { WORKSPACE_PACKAGES?: string },
): boolean {
  const patterns = (env.WORKSPACE_PACKAGES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  // Safe fallback if unconfigured: only the synthetic-version packages.
  if (patterns.length === 0) return PREVIEW_PACKAGES.has(name)

  for (const pattern of patterns) {
    if (pattern.endsWith('*')) {
      if (name.startsWith(pattern.slice(0, -1))) return true
    } else if (name === pattern) {
      return true
    }
  }
  return false
}
