import {
  createTarGzip,
  parseTarGzip,
  type ParsedTarFileItem,
  type TarFileInput,
} from 'nanotar'
import { HttpError } from '../httpError'
import { rewritePackageJson, type RewriteEnv } from './rewritePackageJson'
import { computeDigests } from './digests'
import {
  assertSafeTarballPath,
  isUnderPackageRoot,
} from '../security/validateTarballPath'

export const PACKAGE_JSON_NAMES = new Set([
  'package/package.json',
  './package/package.json',
])

/** The cacheable artifacts for a preview version (everything but the bytes). */
export interface PreviewMeta {
  /** The rewritten package.json, reused to build packument version metadata. */
  packageJson: Record<string, any>
  /** SHA-1 hex of the generated tarball, for `dist.shasum`. */
  shasum: string
  /** SHA-512 SRI of the generated tarball, for `dist.integrity`. */
  integrity: string
}

export interface PreviewBuild extends PreviewMeta {
  /** The gzipped tarball bytes to serve. */
  tarball: Uint8Array
}

/**
 * Parse the upstream gzipped tarball and locate `package/package.json`,
 * returning all entries, the package.json entry, and its parsed contents.
 * Shared by the meta-only and full-rebuild paths below.
 */
async function parsePackageJson(gzippedTarball: Uint8Array): Promise<{
  files: ParsedTarFileItem[]
  pkgEntry: ParsedTarFileItem
  pkg: Record<string, any>
}> {
  const files = await parseTarGzip(gzippedTarball)
  const pkgEntry = files.find((f) => PACKAGE_JSON_NAMES.has(f.name) && f.data)
  if (!pkgEntry || !pkgEntry.data) {
    throw new HttpError(422, 'Upstream tarball is missing package/package.json')
  }
  try {
    return { files, pkgEntry, pkg: JSON.parse(new TextDecoder().decode(pkgEntry.data)) }
  } catch {
    throw new HttpError(422, 'Invalid package/package.json in upstream tarball')
  }
}

/**
 * Parse the upstream tarball and return the rewritten `package.json` without
 * re-gzipping. Used to build packument metadata cheaply for large packages
 * (the platform binaries), where re-tarring/re-gzipping every configured ref
 * would exceed the Worker CPU limit. The full tarball is built lazily, only
 * when the matching binary is actually downloaded.
 */
export async function extractRewrittenPackageJson(
  gzippedTarball: Uint8Array,
  packageName: string,
  version: string,
  env: RewriteEnv,
): Promise<Record<string, any>> {
  const { pkg } = await parsePackageJson(gzippedTarball)
  return rewritePackageJson(pkg, packageName, version, env)
}

/**
 * Rewrite an upstream pkg.pr.new tarball into a preview release:
 *   1. parse gzip + tar,
 *   2. find and rewrite `package/package.json`,
 *   3. repack only entries under the `package/` root, preserving file modes,
 *   4. re-gzip.
 *
 * Only `package/package.json` changes; all other entries pass through byte for
 * byte (with their original attrs/mode), which keeps executables executable.
 */
export async function buildPreviewTarball(
  gzippedTarball: Uint8Array,
  packageName: string,
  version: string,
  env: RewriteEnv,
): Promise<PreviewBuild> {
  const { files, pkgEntry, pkg } = await parsePackageJson(gzippedTarball)

  const rewritten = rewritePackageJson(pkg, packageName, version, env)
  const rewrittenBytes = new TextEncoder().encode(
    `${JSON.stringify(rewritten, null, 2)}\n`,
  )

  const out: TarFileInput[] = []
  for (const file of files) {
    assertSafeTarballPath(file.name)
    if (!isUnderPackageRoot(file.name)) continue
    out.push({
      name: file.name,
      data: file === pkgEntry ? rewrittenBytes : file.data,
      attrs: file.attrs,
    })
  }

  const tarball = await createTarGzip(out)
  const { shasum, integrity } = await computeDigests(tarball)
  return { tarball, packageJson: rewritten, shasum, integrity }
}
