import type { Env } from '../config'
import type { PreviewMeta } from '../tarball/buildPreviewTarball'
import { metaIndexKey } from '../cache/r2Cache'
import { casR2Json } from '../cache/r2Cas'
import { REF_TTL_MS } from './getConfiguredRefs'

/** A version's immutable meta plus the same TTL its ref carries (for pruning). */
type MetaIndexEntry = { meta: PreviewMeta; expiresAt: number }
/** `0.0.0-commit.<sha>` -> its meta. */
export type MetaIndex = Record<string, MetaIndexEntry>

/**
 * The package's meta aggregate (`version -> meta`), read once by the packument
 * instead of one `metaKey` per ref. Empty on absence or a parse error, so the
 * caller falls back to the per-version key.
 */
export async function readMetaIndex(env: Env, name: string): Promise<MetaIndex> {
  const obj = await env.STORAGE.get(metaIndexKey(name))
  if (!obj) return {}
  return obj.json<MetaIndex>().catch(() => ({}))
}

/**
 * Add (or refresh) a version's meta in the package aggregate, pruning entries
 * whose TTL has passed so the object stays bounded to the active ref window.
 * Concurrency-safe via the conditional put; publishes of different packages hit
 * different keys, so they never contend.
 */
export async function upsertMetaIndex(
  env: Env,
  name: string,
  version: string,
  meta: PreviewMeta,
): Promise<void> {
  await casR2Json<MetaIndex>(env, metaIndexKey(name), (index) => {
    const now = Date.now()
    for (const v of Object.keys(index)) {
      if (index[v].expiresAt <= now) delete index[v]
    }
    index[version] = { meta, expiresAt: now + REF_TTL_MS }
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
