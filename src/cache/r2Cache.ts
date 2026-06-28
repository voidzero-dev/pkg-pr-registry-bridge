/** R2 object keys for a generated preview build. */

export function tarballKey(name: string, version: string): string {
  return `tarball/${name}/${version}.tgz`
}

export function metaKey(name: string, version: string): string {
  return `meta/${name}/${version}.json`
}

/**
 * The single object holding the runtime-registered preview refs. Read on every
 * packument request (a cheap R2 get, not a KV list, which is rate-limited).
 */
export function refsIndexKey(): string {
  return 'refs/index.json'
}
