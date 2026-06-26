import type { Env } from '../config'

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
 * Build a registry version document from the (already rewritten) preview
 * package.json. The package name selected the upstream; the synthetic version
 * is authoritative; `dist.tarball` points back at this bridge.
 *
 * MVP1 omits `dist.integrity`/`dist.shasum`: npm/bun compute and pin integrity
 * from the downloaded tarball. Never emit an incorrect integrity value.
 */
export function buildVersionMetadata(
  env: Env,
  packageName: string,
  version: string,
  packageJson: Record<string, any>,
): Record<string, any> {
  const meta: Record<string, any> = {}
  for (const [key, value] of Object.entries(packageJson)) {
    if (DROP_FIELDS.has(key)) continue
    meta[key] = value
  }

  meta.name = packageName
  meta.version = version
  meta._id = `${packageName}@${version}`
  meta.dist = {
    tarball: `${env.PUBLIC_BASE_URL}/tarballs/${packageName}/${version}.tgz`,
  }

  return meta
}
