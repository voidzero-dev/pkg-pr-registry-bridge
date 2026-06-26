import { HttpError } from '../httpError'

/**
 * Reject path traversal and absolute paths in a tarball entry name before it is
 * repacked. Throws on anything unsafe.
 */
export function assertSafeTarballPath(name: string): void {
  const normalized = name.replace(/\\/g, '/')
  if (normalized.startsWith('/')) {
    throw new HttpError(422, `Unsafe absolute path in tarball: ${name}`)
  }
  for (const segment of normalized.split('/')) {
    if (segment === '..') {
      throw new HttpError(422, `Unsafe path traversal in tarball: ${name}`)
    }
  }
}

/**
 * Whether an entry lives under the `package/` root. Only such entries are
 * repacked; npm tarballs put everything under `package/`.
 */
export function isUnderPackageRoot(name: string): boolean {
  const normalized = name.replace(/^\.\//, '').replace(/\\/g, '/')
  return normalized === 'package' || normalized.startsWith('package/')
}
