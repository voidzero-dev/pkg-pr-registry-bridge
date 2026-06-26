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
