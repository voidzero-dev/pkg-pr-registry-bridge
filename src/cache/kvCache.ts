import type { Env } from '../config'
import type { RequestWork } from '../util/requestTiming'
import { withTimeout } from '../util/withTimeout'
import { describeError } from '../util/errors'

// KV is optional acceleration. A slow read must not consume Void's 10s budget.
export const KV_READ_TIMEOUT_MS = 500

async function readCache<T>(
  key: string,
  read: () => Promise<T | null>,
  work: RequestWork,
): Promise<T | null> {
  work.signal.throwIfAborted()
  try {
    const value = await work.timing.measure(`kv.get:${key}`, () =>
      withTimeout(read(), KV_READ_TIMEOUT_MS, () => new Error('KV cache read timed out')),
    )
    work.signal.throwIfAborted()
    work.timing.cache[key] = value == null ? 'miss' : 'hit'
    return value
  } catch (err) {
    work.signal.throwIfAborted()
    work.timing.cache[key] = 'bypass'
    console.warn(`KV cache read failed for ${key}:`, describeError(err))
    return null
  }
}

/** The string is captured before callers can mutate a cached JSON object. */
function writeCache(env: Env, key: string, value: string, ttlSeconds: number, work: RequestWork) {
  work.signal.throwIfAborted()
  work.executionCtx.waitUntil(
    (async () => {
      const startedAt = Date.now()
      let error: string | undefined
      try {
        await env.KV.put(key, value, { expirationTtl: ttlSeconds })
      } catch (err) {
        error = describeError(err)
      }
      const durationMs = Date.now() - startedAt
      if (error || durationMs >= 1000) {
        console.warn(
          JSON.stringify({
            event: 'cache_write',
            requestId: work.timing.requestId,
            key,
            durationMs,
            error,
          }),
        )
      }
    })(),
  )
}

/**
 * Read a JSON value from KV, or compute it and write it back with a TTL.
 *
 * Cache errors and slow reads degrade to a direct compute. Writes run under
 * waitUntil so a slow KV write cannot delay a response. The value is only cached
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
  work: RequestWork,
): Promise<T | null> {
  const cached = await readCache(key, () => env.KV.get<T>(key, 'json'), work)
  if (cached != null) return cached

  const value = await fetcher()
  work.signal.throwIfAborted()
  if (value != null) {
    writeCache(env, key, JSON.stringify(value), ttlSeconds, work)
  }
  return value
}

/**
 * Like {@link kvCached}, but for an already-serialized string body: stores and
 * serves it verbatim (`get(..., 'text')` / `put(value)`), with no JSON parse or
 * re-stringify round-trip. Use when the cached value is the exact bytes to serve
 * (e.g. a large assembled response) and re-encoding it would be wasted work. The
 * fetcher always produces a body, so the result is always cached.
 */
export async function kvCachedText(
  env: Env,
  key: string,
  ttlSeconds: number,
  fetcher: () => Promise<string>,
  work: RequestWork,
): Promise<string> {
  const cached = await readCache(key, () => env.KV.get(key, 'text'), work)
  if (cached !== null) return cached

  const value = await fetcher()
  writeCache(env, key, value, ttlSeconds, work)
  return value
}
