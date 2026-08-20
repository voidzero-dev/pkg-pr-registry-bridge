/**
 * Parsing helpers for npm registry request paths.
 *
 * Package managers spell packages three ways, all of which must resolve to the
 * same name:
 *   /vite-plus
 *   /@voidzero-dev/vite-plus-core
 *   /@voidzero-dev%2Fvite-plus-core   (encoded scoped)
 */

import { isShasum } from '../cache/r2Cache'

export interface PackumentRequest {
  name: string
}

export interface PackageVersionRequest extends PackumentRequest {
  version: string
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

/**
 * Identify an npm package-version request:
 *   /vite-plus/0.0.0-commit.<sha>
 *   /@voidzero-dev/vite-plus-core/0.0.0-commit.<sha>
 *   /@voidzero-dev%2Fvite-plus-core/0.0.0-commit.<sha>
 */
export function parsePackageVersionPath(pathname: string): PackageVersionRequest | null {
  const decoded = decodePath(pathname)
  if (!decoded || decoded.includes('/-/') || decoded.startsWith('-/')) return null

  const segments = decoded.split('/')
  if (decoded.startsWith('@')) {
    if (segments.length !== 3 || segments.some((segment) => !segment)) return null
    return { name: `${segments[0]}/${segments[1]}`, version: segments[2] }
  }

  if (segments.length !== 2 || segments.some((segment) => !segment)) return null
  return { name: segments[0], version: segments[1] }
}

export interface TarballRequest {
  name: string
  version: string
  /** Present for a content-addressed path (`<name>/<version>/<shasum>.tgz`). */
  shasum?: string
}

/**
 * Parse a `<prefix><name>/<version>.tgz` (version-addressed) or
 * `<prefix><name>/<version>/<shasum>.tgz` (content-addressed) path; the name
 * may be scoped. The two shapes are told apart by the basename: a content-
 * addressed build's basename is a 40-hex shasum, which a `0.0.0-commit.<sha>`
 * version can never be, so there is no ambiguity.
 */
function parsePrefixedTarballPath(pathname: string, prefix: string): TarballRequest | null {
  const decoded = decodePath(pathname)
  if (!decoded || !decoded.startsWith(prefix)) return null

  const segments = decoded.slice(prefix.length).split('/')
  const file = segments.pop()
  if (!file || !file.endsWith('.tgz')) return null
  const base = file.slice(0, -'.tgz'.length)

  // Content-addressed `<name>/<version>/<shasum>.tgz`: the basename is a 40-hex
  // shasum (a `0.0.0-commit.<sha>` version never is), and the prior segment is
  // the version. `isShasum` is the shared content-vs-version disambiguator, so
  // the parser and `buildVersionMetadata`'s gate stay in lockstep.
  if (isShasum(base)) {
    const version = segments.pop()
    const name = segments.join('/')
    if (!name || !version) return null
    return { name, version, shasum: base }
  }

  // Legacy version-addressed `<name>/<version>.tgz`.
  const version = base
  const name = segments.join('/')
  if (!name || !version) return null
  return { name, version }
}

/**
 * Parse the bridge's own preview tarball path:
 *   /tarballs/vite-plus/0.0.0-commit.a832a55.tgz                    (version)
 *   /tarballs/vite-plus/0.0.0-commit.a832a55/<shasum>.tgz          (content)
 *   /tarballs/@voidzero-dev/vite-plus-core/0.0.0-commit.a832a55.tgz
 */
export function parseTarballPath(pathname: string): TarballRequest | null {
  return parsePrefixedTarballPath(pathname, 'tarballs/')
}

/**
 * Parse the admin artifact-upload path (CI uploads a prebuilt tarball here):
 *   /-/tarball/vite-plus/0.0.0-commit.a832a55/<shasum>.tgz         (content)
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

  const unscoped = name.startsWith('@') ? (name.split('/').pop() ?? '') : name
  if (!unscoped) return null

  const base = file.slice(0, -'.tgz'.length)
  const prefix = `${unscoped}-`
  if (!base.startsWith(prefix)) return null

  const version = base.slice(prefix.length)
  if (!version) return null
  return { name, version }
}

/**
 * Parse a pkg.pr.new-style direct-download path for the configured repo:
 *   /<owner>/<repo>@<ref>        -> { pkg: <repo>, ref }   (repo's main package)
 *   /<owner>/<repo>/<pkg>@<ref>  -> { pkg, ref }           (<pkg> may be scoped)
 * Returns null when the path is not this form.
 */
export function parsePkgPrNewDownload(
  pathname: string,
  owner: string,
  repo: string,
): { pkg: string; ref: string } | null {
  const decoded = decodePath(pathname)
  const base = `${owner}/${repo}`
  if (!decoded || !decoded.startsWith(base)) return null
  const rest = decoded.slice(base.length)

  let pkg: string
  let ref: string
  if (rest.startsWith('@')) {
    pkg = repo
    ref = rest.slice(1)
  } else if (rest.startsWith('/')) {
    // `<pkg>@<ref>`; lastIndexOf('@') keeps a scoped pkg name intact.
    const seg = rest.slice(1)
    const at = seg.lastIndexOf('@')
    if (at <= 0) return null
    pkg = seg.slice(0, at)
    ref = seg.slice(at + 1)
  } else {
    return null
  }
  return ref && !ref.includes('/') ? { pkg, ref } : null
}

/** Encode a package name for an outbound npm registry URL. */
export function encodeNpmPackageName(name: string): string {
  return name.startsWith('@') ? name.replace('/', '%2F') : name
}
