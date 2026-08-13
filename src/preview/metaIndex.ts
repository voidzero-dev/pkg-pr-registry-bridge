import type { Env } from '../config'
import type { PreviewMeta } from '../tarball/buildPreviewTarball'
import { metaIndexKey, metaKey } from '../cache/r2Cache'
import { casR2Json, readR2Json } from '../cache/r2Cas'
import { r2Get } from '../cache/r2Get'
import { REF_TTL_MS } from './getConfiguredRefs'

/** `0.0.0-commit.<sha>` -> its immutable meta (the same value stored at `metaKey`). */
export type MetaIndex = Record<string, PreviewMeta>

/**
 * The package's meta aggregate, read once by the packument instead of one
 * `metaKey` per ref. Empty on absence or a parse error, so the caller falls back
 * to the per-version key.
 */
export async function readMetaIndex(env: Env, name: string): Promise<MetaIndex> {
  return (await readR2Json<MetaIndex>(env, metaIndexKey(name))).value
}

/**
 * Resolve a version's current meta WITHOUT triggering an in-Worker build: the
 * per-package aggregate first (one R2 get), then the per-version `metaKey`
 * fallback. Used by the serve + download-redirect paths to map a version to its
 * current build's shasum (and thus its content-addressed URL). Returns undefined
 * when nothing is published yet, so the caller falls back to the version URL.
 */
export async function resolveVersionMeta(
  env: Env,
  name: string,
  version: string,
): Promise<PreviewMeta | undefined> {
  const fromIndex = (await readMetaIndex(env, name))[version]
  if (fromIndex) return fromIndex
  const obj = await r2Get(env, metaKey(name, version))
  if (!obj) return undefined
  return obj.json<PreviewMeta>().catch(() => undefined)
}

/**
 * Drop entries whose ref TTL has passed, so the object stays bounded to the
 * active-ref window. The bound is derived from each meta's own `publishedAt`
 * (which is `now` at publish, the same instant the ref's TTL starts), so the
 * aggregate needs no separate expiry field; an unparseable/absent time prunes
 * (the packument fallback still covers such a version via its per-version key).
 */
function pruneExpired(index: MetaIndex): void {
  const cutoff = Date.now() - REF_TTL_MS
  for (const version of Object.keys(index)) {
    if (!(Date.parse(index[version].publishedAt ?? '') > cutoff)) {
      delete index[version]
    }
  }
}

/**
 * Add (or refresh) a version's meta in the package aggregate, pruning expired
 * entries. Concurrency-safe via the conditional put; publishes of different
 * packages hit different keys, so they never contend.
 */
export async function upsertMetaIndex(
  env: Env,
  name: string,
  version: string,
  meta: PreviewMeta,
): Promise<void> {
  await casR2Json<MetaIndex>(env, metaIndexKey(name), (index) => {
    pruneExpired(index)
    index[version] = meta
  })
}

/** Drop a version from the package aggregate (on purge), so it stops being served. */
export async function removeFromMetaIndex(
  env: Env,
  name: string,
  version: string,
): Promise<void> {
  await casR2Json<MetaIndex>(env, metaIndexKey(name), (index) => {
    delete index[version]
  })
}
