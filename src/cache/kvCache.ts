import type { Env } from '../config'

/**
 * Read a JSON value from KV, or compute it and write it back with a TTL.
 *
 * Cache errors degrade to a direct compute (logged, never thrown), so a flaky
 * KV never fails the request. The computed value is returned but only cached
 * when non-nullish, so the caller controls negative caching by what its fetcher
 * returns: return `{}` to cache a not-found cheaply, or `null` to leave it
 * uncached. `KV.get(..., 'json')` returns a fresh parse each call, so the caller
 * may safely mutate the result without corrupting the cache.
 *
 * KV, not the Cache API, because the Void runtime forbids `caches.default`.
 */
export async function kvCached<T>(
  env: Env,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<T | null>,
): Promise<T | null> {
  try {
    const cached = await env.KV.get<T>(key, 'json')
    if (cached != null) return cached
  } catch (err) {
    console.warn(`KV cache read failed for ${key}:`, err)
  }

  const value = await fetcher()
  if (value != null) {
    try {
      await env.KV.put(key, JSON.stringify(value), { expirationTtl: ttlSeconds })
    } catch (err) {
      // Best-effort population; log so a failing runtime stays visible.
      console.warn(`KV cache write failed for ${key}:`, err)
    }
  }
  return value
}
