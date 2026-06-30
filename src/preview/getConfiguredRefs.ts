import type { Env } from '../config'
import {
  parseConfiguredPreviewRefs,
  parseConfiguredPreviewRefsSafe,
  parseSingleRef,
  prNumberFromUrl,
  type ConfiguredPreviewRef,
  type ParsedPreviewRef,
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

/** Per-ref runtime state: expiry plus optional publish time and PR url. */
type RefEntry = { expiresAt: number; publishedAt?: string; prUrl?: string }
/** canonical `commit.<sha>` -> RefEntry. */
type RefIndex = Record<string, RefEntry>

function canonical(ref: ParsedPreviewRef): string {
  return `${ref.type}.${ref.ref}`
}

async function readRefIndex(
  env: Env,
): Promise<{ index: RefIndex; etag: string | null }> {
  const obj = await env.STORAGE.get(REFS_INDEX_KEY)
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
    const written = await env.STORAGE.put(
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

  const fromR2: ConfiguredPreviewRef[] = []
  try {
    const { index } = await readRefIndex(env)
    const now = Date.now()
    // Each index entry is already in hand here, so attach its runtime state
    // directly instead of re-deriving the key and looking it back up.
    for (const [key, entry] of Object.entries(index)) {
      if (entry.expiresAt <= now) continue
      const parsed = parseSingleRef(key)
      if (!parsed) continue
      fromR2.push({
        ...parsed,
        publishedAt: entry.publishedAt,
        prUrl: entry.prUrl,
        prNumber: prNumberFromUrl(entry.prUrl),
        expiresAt: entry.expiresAt,
      })
    }
  } catch (err) {
    console.warn('Failed to read preview refs from R2:', err)
  }

  const byVersion = new Map<string, ConfiguredPreviewRef>()
  for (const ref of [...fromEnv, ...fromR2]) byVersion.set(ref.version, ref)
  return [...byVersion.values()]
}

/**
 * Map each PR number to its latest-published commit version among `refs`
 * (max publishedAt wins). Used for the `pr-<n>` dist-tag and the pkg.pr.new
 * style download URL. `accept` optionally restricts eligible versions (e.g.
 * only versions present in a built packument).
 */
export function latestVersionByPr(
  refs: ConfiguredPreviewRef[],
  accept: (version: string) => boolean = () => true,
): Map<string, string> {
  const out = new Map<string, string>()
  const latestT = new Map<string, number>()
  for (const ref of refs) {
    if (!ref.prNumber || !accept(ref.version)) continue
    const t = ref.publishedAt ? Date.parse(ref.publishedAt) : 0
    const prev = latestT.get(ref.prNumber)
    if (prev === undefined || t >= prev) {
      latestT.set(ref.prNumber, t)
      out.set(ref.prNumber, ref.version)
    }
  }
  return out
}

/** Validate and register a ref. Concurrency-safe via the conditional put. */
export async function registerRef(
  env: Env,
  ref: string,
  extra?: { publishedAt?: string; prUrl?: string },
): Promise<ParsedPreviewRef> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  await mutateRefIndex(env, (index) => {
    const existing = index[canonical(parsed)]
    // Preserve a prior publish time / PR url when re-registering without them.
    index[canonical(parsed)] = {
      expiresAt: Date.now() + REF_TTL_MS,
      publishedAt: extra?.publishedAt ?? existing?.publishedAt,
      prUrl: extra?.prUrl ?? existing?.prUrl,
    }
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
