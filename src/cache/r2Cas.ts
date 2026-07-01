import type { Env } from '../config'

const MAX_CAS_ATTEMPTS = 6

/**
 * Read-modify-write a JSON object in R2 with an etag compare-and-swap plus retry.
 * `mutate` receives the current object (or `{}` when the key is absent) and
 * mutates it in place; the conditional put only succeeds if the object is
 * unchanged since the read, so a losing writer re-reads and retries. Used for the
 * small runtime indexes (the refs index, the per-package meta index) that
 * concurrent publishes update.
 */
export async function casR2Json<T extends object>(
  env: Env,
  key: string,
  mutate: (current: T) => void,
): Promise<void> {
  for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt++) {
    const obj = await env.STORAGE.get(key)
    const current: T = obj
      ? await obj.json<T>().catch(() => ({}) as T)
      : ({} as T)
    const etag = obj?.etag ?? null
    mutate(current)
    const written = await env.STORAGE.put(key, JSON.stringify(current), {
      onlyIf: etag ? { etagMatches: etag } : { etagDoesNotMatch: '*' },
      httpMetadata: { contentType: 'application/json' },
    })
    if (written !== null) return
    // A concurrent writer won the race; re-read the new state and retry.
  }
  throw new Error(`Could not update ${key} (R2 write contention)`)
}
