/**
 * Parsing helpers for npm registry request paths.
 *
 * Package managers spell packages three ways, all of which must resolve to the
 * same name:
 *   /vite-plus
 *   /@voidzero-dev/vite-plus-core
 *   /@voidzero-dev%2Fvite-plus-core   (encoded scoped)
 */

export interface PackumentRequest {
  name: string
}

/**
 * Identify a packument request from a request path. Returns null when the path
 * is not a plain packument (e.g. an npm tarball path containing `/-/`, the
 * root, or some other registry API endpoint), in which case the caller should
 * proxy the request to npm.
 */
export function parsePackagePath(pathname: string): PackumentRequest | null {
  const raw = pathname.replace(/^\/+/, '')
  if (!raw) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    return null
  }

  // npm tarball URLs and registry APIs use a `/-/` segment.
  if (decoded.includes('/-/') || decoded.startsWith('-/')) return null

  const segments = decoded.split('/')
  if (decoded.startsWith('@')) {
    // Scoped: exactly `@scope/name`.
    if (segments.length !== 2 || !segments[0] || !segments[1]) return null
    return { name: `${segments[0]}/${segments[1]}` }
  }

  // Unscoped: a single segment.
  if (segments.length !== 1 || !segments[0]) return null
  return { name: segments[0] }
}

export interface TarballRequest {
  name: string
  version: string
}

/**
 * Parse the bridge's own preview tarball path:
 *   /tarballs/vite-plus/0.0.0-pr.1891.tgz
 *   /tarballs/@voidzero-dev/vite-plus-core/0.0.0-pr.1891.tgz
 */
export function parseTarballPath(pathname: string): TarballRequest | null {
  const raw = pathname.replace(/^\/+/, '')
  if (!raw.startsWith('tarballs/')) return null

  let rest: string
  try {
    rest = decodeURIComponent(raw.slice('tarballs/'.length))
  } catch {
    return null
  }

  const segments = rest.split('/')
  const file = segments.pop()
  if (!file || !file.endsWith('.tgz')) return null

  const version = file.slice(0, -'.tgz'.length)
  const name = segments.join('/')
  if (!name || !version) return null
  return { name, version }
}

/** Encode a package name for an outbound npm registry URL. */
export function encodeNpmPackageName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}
