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

/** Strip leading slashes and percent-decode a request path; null if malformed. */
function decodePath(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname.replace(/^\/+/, ''))
  } catch {
    return null
  }
}

/**
 * Identify a packument request from a request path. Returns null when the path
 * is not a plain packument (e.g. an npm tarball path containing `/-/`, the
 * root, or some other registry API endpoint), in which case the caller should
 * proxy the request to npm.
 */
export function parsePackagePath(pathname: string): PackumentRequest | null {
  const decoded = decodePath(pathname)
  if (!decoded) return null

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

/** Parse a `<prefix><name>/<version>.tgz` path (name may be scoped). */
function parsePrefixedTarballPath(
  pathname: string,
  prefix: string,
): TarballRequest | null {
  const decoded = decodePath(pathname)
  if (!decoded || !decoded.startsWith(prefix)) return null

  const segments = decoded.slice(prefix.length).split('/')
  const file = segments.pop()
  if (!file || !file.endsWith('.tgz')) return null

  const version = file.slice(0, -'.tgz'.length)
  const name = segments.join('/')
  if (!name || !version) return null
  return { name, version }
}

/**
 * Parse the bridge's own preview tarball path:
 *   /tarballs/vite-plus/0.0.0-commit.a832a55.tgz
 *   /tarballs/@voidzero-dev/vite-plus-core/0.0.0-commit.a832a55.tgz
 */
export function parseTarballPath(pathname: string): TarballRequest | null {
  return parsePrefixedTarballPath(pathname, 'tarballs/')
}

/**
 * Parse the admin artifact-upload path (CI uploads a prebuilt tarball here):
 *   /-/tarball/vite-plus/0.0.0-commit.a832a55.tgz
 *   /-/tarball/@voidzero-dev/vite-plus-core/0.0.0-commit.a832a55.tgz
 */
export function parseUploadPath(pathname: string): TarballRequest | null {
  return parsePrefixedTarballPath(pathname, '-/tarball/')
}

/**
 * Parse an npm-convention tarball path (the layout registry.npmjs.org uses):
 *   /vite-plus/-/vite-plus-0.0.0-commit.<sha>.tgz
 *   /@voidzero-dev/vite-plus-core/-/vite-plus-core-0.0.0-commit.<sha>.tgz
 *   /@voidzero-dev%2Fvite-plus-core/-/vite-plus-core-0.0.0-commit.<sha>.tgz
 *
 * Clients are supposed to read `dist.tarball` from the packument, but some
 * (and stale lockfiles) synthesize this path from the registry base instead.
 * The bridge serves preview builds here too so those clients still resolve.
 *
 * npm names the file `<unscoped-name>-<version>.tgz`. We split on the `/-/`
 * separator: the left side is the package name, and the version is the filename
 * with the `<unscoped-name>-` prefix and `.tgz` suffix stripped. Returns null
 * when the path is not a well-formed tarball path or the filename does not match
 * the package name (so the caller can fall back to the npm redirect).
 */
export function parseNpmTarballPath(pathname: string): TarballRequest | null {
  // Cheap early-out: skip the decode for the common packument/redirect paths,
  // which never contain the `/-/` tarball separator (it is never encoded).
  if (!pathname.includes('/-/')) return null

  const decoded = decodePath(pathname)
  if (!decoded) return null

  const sep = decoded.indexOf('/-/')
  if (sep === -1) return null

  const name = decoded.slice(0, sep)
  const file = decoded.slice(sep + '/-/'.length)
  if (!name || !file.endsWith('.tgz') || file.includes('/')) return null

  const unscoped = name.startsWith('@') ? name.split('/').pop() ?? '' : name
  if (!unscoped) return null

  const base = file.slice(0, -'.tgz'.length)
  const prefix = `${unscoped}-`
  if (!base.startsWith(prefix)) return null

  const version = base.slice(prefix.length)
  if (!version) return null
  return { name, version }
}

/** Encode a package name for an outbound npm registry URL. */
export function encodeNpmPackageName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}
