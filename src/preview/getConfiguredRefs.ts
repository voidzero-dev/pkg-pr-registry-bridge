import type { Env } from '../config'
import {
  parseConfiguredPreviewRefs,
  parseConfiguredPreviewRefsSafe,
  type ConfiguredPreviewRef,
} from './parseConfiguredPreviewRefs'
import { REFS_INDEX_KEY } from '../cache/r2Cache'

// Runtime-registered refs live in ONE R2 object, read on every packument request
// with a cheap `get`. The earlier design stored one KV key per ref and read them
// with `list`, but KV `list` is rate-limited to 1,000/day on the free plan (vs
// 100k reads), and a single install fetches ~10 packuments, so install traffic
// blew through it. Updates use R2 conditional puts (etag compare-and-swap) so
// concurrent registrations can't clobber each other, the concurrency safety the
// per-key KV layout was providing, without any `list`.
const REF_TTL_MS = 90 * 24 * 60 * 60 * 1000
const MAX_CAS_ATTEMPTS = 6

/** canonical `commit.<sha>` -> expiry (epoch ms). */
type RefIndex = Record<string, { expiresAt: number }>

function canonical(ref: ConfiguredPreviewRef): string {
  return `${ref.type}.${ref.ref}`
}

async function readRefIndex(
  env: Env,
): Promise<{ index: RefIndex; etag: string | null }> {
  const obj = await env.TARBALL_CACHE.get(REFS_INDEX_KEY)
  if (!obj) return { index: {}, etag: null }
  const index = await obj.json<RefIndex>().catch(() => ({}) as RefIndex)
  return { index, etag: obj.etag }
}

/**
 * Read-modify-write the refs index atomically. The conditional put only succeeds
 * if the object is unchanged since we read it (or absent, on first write); a
 * losing writer re-reads and retries. Expired entries are pruned on every write
 * so the object stays small.
 */
async function mutateRefIndex(
  env: Env,
  mutate: (index: RefIndex) => void,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const { index, etag } = await readRefIndex(env)
    const now = Date.now()
    for (const key of Object.keys(index)) {
      if (index[key].expiresAt <= now) delete index[key]
    }
    mutate(index)
    const written = await env.TARBALL_CACHE.put(
      REFS_INDEX_KEY,
      JSON.stringify(index),
      {
        onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
        httpMetadata: { contentType: 'application/json' },
      },
    )
    if (written !== null) return
    // A concurrent writer won the race; re-read the new state and retry.
  }
  throw new Error('Could not update the refs index (R2 write contention)')
}

/**
 * Resolve the preview refs to inject into packuments: the static
 * `VITE_PLUS_PREVIEW_REFS` var merged with refs registered at runtime in R2.
 */
export async function getConfiguredRefs(
  env: Env,
): Promise<ConfiguredPreviewRef[]> {
  const fromEnv = parseConfiguredPreviewRefsSafe(env.VITE_PLUS_PREVIEW_REFS)

  let fromR2: ConfiguredPreviewRef[] = []
  try {
    const { index } = await readRefIndex(env)
    const now = Date.now()
    const live = Object.keys(index).filter((c) => index[c].expiresAt > now)
    fromR2 = parseConfiguredPreviewRefsSafe(live.join(','))
  } catch (err) {
    console.warn('Failed to read preview refs from R2:', err)
  }

  const byVersion = new Map<string, ConfiguredPreviewRef>()
  for (const ref of [...fromEnv, ...fromR2]) byVersion.set(ref.version, ref)
  return [...byVersion.values()]
}

/** Validate and register a ref. Concurrency-safe via the conditional put. */
export async function registerRef(
  env: Env,
  ref: string,
): Promise<ConfiguredPreviewRef> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  await mutateRefIndex(env, (index) => {
    index[canonical(parsed)] = { expiresAt: Date.now() + REF_TTL_MS }
  })
  return parsed
}

/** Remove a runtime-registered ref. */
export async function unregisterRef(env: Env, ref: string): Promise<void> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  await mutateRefIndex(env, (index) => {
    delete index[canonical(parsed)]
  })
}
