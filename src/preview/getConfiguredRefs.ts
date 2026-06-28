import type { Env } from '../config'
import {
  parseConfiguredPreviewRefs,
  parseConfiguredPreviewRefsSafe,
  type ConfiguredPreviewRef,
} from './parseConfiguredPreviewRefs'

// Each registered ref is its own KV key (`ref:<canonical>`). Registration is
// therefore an independent `put` with no read-modify-write, so simultaneous
// registrations (e.g. several PRs publishing at once) never overwrite each
// other. Reading enumerates the keys via `list`, which is eventually consistent
// (a freshly registered ref can take up to ~60s to appear), an acceptable trade
// for never losing a ref.
const KV_PREFIX = 'ref:'

// Bound KV growth, aligned with the R2 tarball lifecycle (90 days). Re-running
// the publish action on a new commit re-registers and refreshes the TTL.
const REF_TTL_SECONDS = 90 * 24 * 60 * 60

function canonical(ref: ConfiguredPreviewRef): string {
  return `${ref.type}.${ref.ref}`
}

async function listKvRefs(env: Env): Promise<string[]> {
  if (!env.PREVIEW_REFS) return []
  const refs: string[] = []
  let cursor: string | undefined
  do {
    const page = await env.PREVIEW_REFS.list({ prefix: KV_PREFIX, cursor })
    for (const key of page.keys) refs.push(key.name.slice(KV_PREFIX.length))
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return refs
}

/**
 * Resolve the preview refs to inject into packuments: the static
 * `VITE_PLUS_PREVIEW_REFS` var merged with refs registered at runtime in KV.
 */
export async function getConfiguredRefs(
  env: Env,
): Promise<ConfiguredPreviewRef[]> {
  const fromEnv = parseConfiguredPreviewRefsSafe(env.VITE_PLUS_PREVIEW_REFS)

  let fromKv: ConfiguredPreviewRef[] = []
  try {
    fromKv = parseConfiguredPreviewRefsSafe((await listKvRefs(env)).join(','))
  } catch (err) {
    console.warn('Failed to read preview refs from KV:', err)
  }

  const byVersion = new Map<string, ConfiguredPreviewRef>()
  for (const ref of [...fromEnv, ...fromKv]) byVersion.set(ref.version, ref)
  return [...byVersion.values()]
}

/** Validate and register a ref. Concurrency-safe (independent per-ref key). */
export async function registerRef(
  env: Env,
  ref: string,
): Promise<ConfiguredPreviewRef> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  if (!env.PREVIEW_REFS) {
    throw new Error('PREVIEW_REFS KV namespace is not configured')
  }
  await env.PREVIEW_REFS.put(
    `${KV_PREFIX}${canonical(parsed)}`,
    JSON.stringify({ version: parsed.version, tag: parsed.tag }),
    { expirationTtl: REF_TTL_SECONDS },
  )
  return parsed
}

/** Remove a runtime-registered ref. */
export async function unregisterRef(env: Env, ref: string): Promise<void> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  if (!env.PREVIEW_REFS) {
    throw new Error('PREVIEW_REFS KV namespace is not configured')
  }
  await env.PREVIEW_REFS.delete(`${KV_PREFIX}${canonical(parsed)}`)
}
