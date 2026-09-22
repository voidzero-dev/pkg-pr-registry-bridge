import type { Env } from '../config'
import { describeError } from '../util/errors'
import type { RequestWork } from '../util/requestTiming'
import { withTimeout } from '../util/withTimeout'

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
function scheduleCacheWrite(
  env: Env,
  key: string,
  value: string,
  ttlSeconds: number,
  work: RequestWork,
): void {
  work.signal.throwIfAborted()
  work.executionCtx.waitUntil(putCache(env, key, value, ttlSeconds, work.timing.requestId))
}

async function putCache(
  env: Env,
  key: string,
  value: string,
  ttlSeconds: number,
  requestId: string,
): Promise<void> {
  const startedAt = Date.now()
  let error: string | undefined
  try {
    await env.KV.put(key, value, { expirationTtl: ttlSeconds })
  } catch (err) {
    error = describeError(err)
  }
  const durationMs = Date.now() - startedAt
  if (error || durationMs >= 1000) {
    console.warn(JSON.stringify({ event: 'cache_write', requestId, key, durationMs, error }))
  }
}

/**
 * Read a JSON value from KV, or compute it and write it back with a TTL.
 *
 * Errors and slow reads bypass the cache; waitUntil keeps writes off the response
 * path. Return `{}` from the fetcher to cache a not-found, or `null` to leave it
 * uncached. Each read parses fresh JSON, so callers can safely mutate the result.
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
    scheduleCacheWrite(env, key, JSON.stringify(value), ttlSeconds, work)
  }
  return value
}

/**
 * Cache an already-serialized response verbatim, without a JSON round-trip.
 * The fetcher always returns a body, so every successful result is cached.
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
  scheduleCacheWrite(env, key, value, ttlSeconds, work)
  return value
}
