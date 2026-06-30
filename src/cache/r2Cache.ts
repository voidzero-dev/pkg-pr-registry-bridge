/** R2 object keys and the public URL for a generated preview build. */
import type { Env } from '../config'

export function tarballKey(name: string, version: string): string {
  return `tarball/${name}/${version}.tgz`
}

/** Public URL of a preview tarball (the inverse of parseTarballPath). */
export function tarballUrl(
  env: Pick<Env, 'PUBLIC_BASE_URL'>,
  name: string,
  version: string,
): string {
  return `${env.PUBLIC_BASE_URL}/tarballs/${name}/${version}.tgz`
}

export function metaKey(name: string, version: string): string {
  return `meta/${name}/${version}.json`
}

/**
 * The single object holding the runtime-registered preview refs. Read on every
 * packument request (a cheap R2 get, not a KV list, which is rate-limited).
 */
export const REFS_INDEX_KEY = 'refs/index.json'
