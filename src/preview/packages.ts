import { splitCsv } from '../util/splitCsv'

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

// `WORKSPACE_PACKAGES` is a static Worker var: constant for the isolate's
// lifetime, but `isWorkspacePackage` is called multiple times per request. A
// single-entry memo (keyed by the raw string) skips the split/trim/filter
// allocation on every call while still handling the differing configs each
// test in this suite passes.
let patternsMemo: { raw: string; patterns: string[] } | undefined

function workspacePatterns(raw: string): string[] {
  if (patternsMemo?.raw !== raw) {
    patternsMemo = { raw, patterns: splitCsv(raw) }
  }
  return patternsMemo.patterns
}

/**
 * Packages the tarball endpoint may serve and whose pkg.pr.new dependency URLs
 * are routed through the bridge. Broader than PREVIEW_PACKAGES: it also covers
 * the repo's other workspace artifacts (e.g. the platform binaries).
 *
 * Driven by the `WORKSPACE_PACKAGES` config (comma-separated exact names or
 * `prefix*` patterns) so new packages need no code change. The fixed upstream
 * owner/repo is the real security boundary; a name not published there simply
 * 404s from pkg.pr.new. Only PREVIEW_PACKAGES get synthetic versions injected
 * into packuments.
 */
export function isWorkspacePackage(
  name: string,
  env: { WORKSPACE_PACKAGES?: string },
): boolean {
  const patterns = workspacePatterns(env.WORKSPACE_PACKAGES ?? '')

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
