import type { Env } from '../config'
import {
  parseConfiguredPreviewRefs,
  parseSingleRef,
  prNumberFromUrl,
  type ConfiguredPreviewRef,
  type ParsedPreviewRef,
} from './parseConfiguredPreviewRefs'
import { REFS_INDEX_KEY } from '../cache/r2Cache'
import { casR2Json, readR2Json } from '../cache/r2Cas'
import { describeError } from '../util/errors'

// Runtime-registered refs live in ONE R2 object, read on every packument request
// with a cheap `get`. The earlier design stored one KV key per ref and read them
// with `list`, but KV `list` is rate-limited to 1,000/day on the free plan (vs
// 100k reads), and a single install fetches ~10 packuments, so install traffic
// blew through it. Updates use R2 conditional puts (etag compare-and-swap) so
// concurrent registrations can't clobber each other, the concurrency safety the
// per-key KV layout was providing, without any `list`.
export const REF_TTL_MS = 90 * 24 * 60 * 60 * 1000

/** Per-ref runtime state: expiry plus optional publish time and PR url. */
type RefEntry = { expiresAt: number; publishedAt?: string; prUrl?: string }
/** canonical `commit.<sha>` -> RefEntry. */
type RefIndex = Record<string, RefEntry>

function canonical(ref: ParsedPreviewRef): string {
  return `${ref.type}.${ref.ref}`
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
  await casR2Json<RefIndex>(env, REFS_INDEX_KEY, (index) => {
    const now = Date.now()
    for (const key of Object.keys(index)) {
      if (index[key].expiresAt <= now) delete index[key]
    }
    mutate(index)
  })
}

/**
 * Resolve the preview refs to inject into packuments, from the runtime refs
 * index in R2 (registered via the admin endpoints / the publish action). Also
 * returns the index etag, which changes on every ref mutation, so callers that
 * cache derived output can invalidate on any ref change. Null etag when the
 * index is absent or unreadable.
 */
export async function getConfiguredRefsWithEtag(
  env: Env,
): Promise<{ refs: ConfiguredPreviewRef[]; etag: string | null }> {
  let etag: string | null = null
  const refs: ConfiguredPreviewRef[] = []
  try {
    const { value: index, etag: indexEtag } = await readR2Json<RefIndex>(
      env,
      REFS_INDEX_KEY,
    )
    etag = indexEtag
    const now = Date.now()
    // Each index entry is already in hand here, so attach its runtime state
    // directly instead of re-deriving the key and looking it back up.
    for (const [key, entry] of Object.entries(index)) {
      if (entry.expiresAt <= now) continue
      const parsed = parseSingleRef(key)
      if (!parsed) continue
      refs.push({
        ...parsed,
        publishedAt: entry.publishedAt,
        prUrl: entry.prUrl,
        prNumber: prNumberFromUrl(entry.prUrl),
        expiresAt: entry.expiresAt,
      })
    }
  } catch (err) {
    console.warn('Failed to read preview refs from R2:', describeError(err))
  }

  return { refs, etag }
}

export async function getConfiguredRefs(
  env: Env,
): Promise<ConfiguredPreviewRef[]> {
  return (await getConfiguredRefsWithEtag(env)).refs
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

/**
 * Remove a ref from the runtime index (used by purge with `unregister: true`,
 * e.g. to fully clean up a smoke-test artifact). Concurrency-safe via the
 * conditional put; removing an absent ref is a no-op.
 */
export async function unregisterRef(env: Env, ref: string): Promise<void> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  await mutateRefIndex(env, (index) => {
    delete index[canonical(parsed)]
  })
}

/** Validate and register a ref. Concurrency-safe via the conditional put. */
export async function registerRef(
  env: Env,
  ref: string,
  extra?: {
    publishedAt?: string
    prUrl?: string
    /**
     * Refuse to re-point an already-registered ref at a different pull request
     * (RFC 0002 SR-2). A commit belongs to one PR, and the `pr-<n>` dist-tag
     * follows `prUrl`, so allowing a rewrite would let a later publish drag
     * another PR's tag onto this commit. Set for CI (OIDC) publishers; the
     * operator token can still correct a bad registration.
     *
     * Re-registering the same ref with the same prUrl stays fine, and so does a
     * PR accumulating one ref per pushed commit: that is how `pr-<n>` is meant
     * to advance to a PR's head build.
     */
    immutablePrUrl?: boolean
  },
): Promise<ParsedPreviewRef> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  await mutateRefIndex(env, (index) => {
    const existing = index[canonical(parsed)]
    if (
      extra?.immutablePrUrl &&
      extra.prUrl &&
      existing?.prUrl &&
      existing.prUrl !== extra.prUrl
    ) {
      throw new Error(
        `ref ${canonical(parsed)} is already registered to ${existing.prUrl}`,
      )
    }
    // Preserve a prior publish time / PR url when re-registering without them.
    index[canonical(parsed)] = {
      expiresAt: Date.now() + REF_TTL_MS,
      publishedAt: extra?.publishedAt ?? existing?.publishedAt,
      prUrl: extra?.prUrl ?? existing?.prUrl,
    }
  })
  return parsed
}
