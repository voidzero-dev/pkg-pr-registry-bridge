import type { Env } from '../config'
import {
  parseConfiguredPreviewRefs,
  parseConfiguredPreviewRefsSafe,
  type ConfiguredPreviewRef,
} from './parseConfiguredPreviewRefs'

// All runtime refs live under a single KV key (a JSON string array). A single
// `get` is strongly consistent in the region of the write, so a freshly
// registered ref is reflected immediately there; `list()` would add cache
// latency. Writes are rare (admin-only), so the read-modify-write is fine.
const REFS_KEY = 'refs'

function canonical(ref: ConfiguredPreviewRef): string {
  return `${ref.type}.${ref.ref}`
}

async function readKvRefs(env: Env): Promise<string[]> {
  if (!env.PREVIEW_REFS) return []
  const raw = await env.PREVIEW_REFS.get(REFS_KEY)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(String) : []
  } catch {
    return []
  }
}

async function writeKvRefs(env: Env, refs: string[]): Promise<void> {
  if (!env.PREVIEW_REFS) {
    throw new Error('PREVIEW_REFS KV namespace is not configured')
  }
  await env.PREVIEW_REFS.put(REFS_KEY, JSON.stringify(refs))
}

/**
 * Resolve the preview refs to inject into packuments: the static
 * `VITE_PLUS_PREVIEW_REFS` var merged with any refs registered at runtime in
 * KV. KV lets refs be added without a redeploy.
 */
export async function getConfiguredRefs(
  env: Env,
): Promise<ConfiguredPreviewRef[]> {
  const fromEnv = parseConfiguredPreviewRefsSafe(env.VITE_PLUS_PREVIEW_REFS)

  let fromKv: ConfiguredPreviewRef[] = []
  try {
    fromKv = parseConfiguredPreviewRefsSafe((await readKvRefs(env)).join(','))
  } catch (err) {
    console.warn('Failed to read preview refs from KV:', err)
  }

  const byVersion = new Map<string, ConfiguredPreviewRef>()
  for (const ref of [...fromEnv, ...fromKv]) byVersion.set(ref.version, ref)
  return [...byVersion.values()]
}

/** Validate and register a ref in KV. Returns the parsed ref. */
export async function registerRef(
  env: Env,
  ref: string,
): Promise<ConfiguredPreviewRef> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  const canon = canonical(parsed)
  const refs = await readKvRefs(env)
  if (!refs.includes(canon)) refs.push(canon)
  await writeKvRefs(env, refs)
  return parsed
}

/** Remove a runtime-registered ref from KV. */
export async function unregisterRef(env: Env, ref: string): Promise<void> {
  const [parsed] = parseConfiguredPreviewRefs(ref)
  const canon = canonical(parsed)
  const refs = (await readKvRefs(env)).filter((r) => r !== canon)
  await writeKvRefs(env, refs)
}
