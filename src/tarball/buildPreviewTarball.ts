import {
  createTarGzip,
  parseTarGzip,
  type TarFileInput,
} from 'nanotar'
import { HttpError } from '../httpError'
import { rewritePackageJson } from './rewritePackageJson'
import {
  assertSafeTarballPath,
  isUnderPackageRoot,
} from '../security/validateTarballPath'

const PACKAGE_JSON_NAMES = new Set([
  'package/package.json',
  './package/package.json',
])

export interface PreviewBuild {
  /** The gzipped tarball bytes to serve. */
  tarball: Uint8Array
  /** The rewritten package.json, reused to build packument version metadata. */
  packageJson: Record<string, any>
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
): Promise<PreviewBuild> {
  const files = await parseTarGzip(gzippedTarball)

  const pkgEntry = files.find(
    (f) => PACKAGE_JSON_NAMES.has(f.name) && f.data,
  )
  if (!pkgEntry || !pkgEntry.data) {
    throw new HttpError(422, 'Upstream tarball is missing package/package.json')
  }

  let pkg: Record<string, any>
  try {
    pkg = JSON.parse(new TextDecoder().decode(pkgEntry.data))
  } catch {
    throw new HttpError(422, 'Invalid package/package.json in upstream tarball')
  }

  const rewritten = rewritePackageJson(pkg, packageName, version)
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
  return { tarball, packageJson: rewritten }
}
