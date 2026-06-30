import type { Env } from '../config'
import type { PreviewMeta } from '../tarball/buildPreviewTarball'
import { tarballUrl } from '../cache/r2Cache'

/**
 * Fields from a package.json that should not appear in a registry version
 * document. devDependencies are not installed for dependencies, and the
 * underscore-prefixed fields are registry/publish internals.
 */
const DROP_FIELDS = new Set([
  'devDependencies',
  'readme',
  'readmeFilename',
  'gitHead',
  '_id',
  '_rev',
  '_npmVersion',
  '_nodeVersion',
  '_npmUser',
  '_npmOperationalInternal',
  '_hasShrinkwrap',
  'maintainers',
  'dist',
])

/**
 * Build a registry version document from the cached preview meta (rewritten
 * package.json + integrity). The package name selected the upstream; the
 * synthetic version is authoritative; `dist.tarball` points back at this bridge.
 *
 * `dist.integrity`/`dist.shasum` are computed from the exact generated tarball
 * bytes and only emitted when present (older cached builds may lack them, in
 * which case npm/bun compute integrity from the downloaded tarball).
 */
export function buildVersionMetadata(
  env: Env,
  packageName: string,
  version: string,
  preview: PreviewMeta,
): Record<string, any> {
  const meta: Record<string, any> = {}
  for (const [key, value] of Object.entries(preview.packageJson)) {
    if (DROP_FIELDS.has(key)) continue
    meta[key] = value
  }

  meta.name = packageName
  meta.version = version
  meta._id = `${packageName}@${version}`

  const dist: Record<string, any> = {
    tarball: tarballUrl(env, packageName, version),
  }
  if (preview.shasum) dist.shasum = preview.shasum
  if (preview.integrity) dist.integrity = preview.integrity
  meta.dist = dist

  return meta
}
