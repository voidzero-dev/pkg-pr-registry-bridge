import { HttpError } from '../httpError'

/**
 * Normalize a tar entry name to the single spelling every check agrees on:
 * backslashes converted, a leading `./` stripped, repeated slashes collapsed,
 * a trailing slash dropped.
 *
 * `package/a.js`, `./package/a.js` and `package//a.js` are the same file to an
 * extractor, so they must be the same string here. Normalize once and pass the
 * result to the helpers below; comparing different spellings of one path is
 * exactly the disagreement the archive policy exists to remove.
 */
export function normalizeEntryName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
}

/**
 * Reject path traversal and absolute paths in a tarball entry name before it is
 * repacked. Throws on anything unsafe.
 *
 * Normalizes internally rather than requiring a pre-normalized name. Callers
 * already normalize once for the duplicate key, and `normalizeEntryName` is
 * idempotent, so the extra pass is free; the point is that a caller who forgets
 * must not silently get a weaker check out of a security helper.
 */
export function assertSafeTarballPath(rawName: string): void {
  const name = normalizeEntryName(rawName)
  if (name.startsWith('/')) {
    throw new HttpError(422, `Unsafe absolute path in tarball: ${name}`)
  }
  for (const segment of name.split('/')) {
    if (segment === '..') {
      throw new HttpError(422, `Unsafe path traversal in tarball: ${name}`)
    }
  }
}

/**
 * Whether an entry lives under the `package/` root. Only such entries are
 * repacked; npm tarballs put everything under `package/`. Normalizes
 * internally, for the reason above.
 */
export function isUnderPackageRoot(rawName: string): boolean {
  const name = normalizeEntryName(rawName)
  return name === 'package' || name.startsWith('package/')
}

/**
 * Whether an entry is the package manifest. One predicate shared by the archive
 * policy (which requires exactly one) and the repack (which rewrites it), so
 * the two cannot disagree about which entry is authoritative. Normalizes
 * internally, for the reason above.
 */
export function isPackageManifest(rawName: string): boolean {
  return normalizeEntryName(rawName) === 'package/package.json'
}
