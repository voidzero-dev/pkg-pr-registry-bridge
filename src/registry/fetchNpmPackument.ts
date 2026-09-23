import type { Env } from '../config'
import { HttpError } from '../httpError'
import { kvCached } from '../cache/kvCache'
import type { RequestWork } from '../util/requestTiming'
import { withTimeout } from '../util/withTimeout'
import { encodeNpmPackageName } from './parsePackageName'

// Abbreviated packument format. Always request this from npm: it is an order
// of magnitude smaller than the full packument (which some clients' Accept
// headers, with q-values, otherwise coax npm into returning). A large response
// is far more likely to be disrupted by a package manager's HTTP/2 stream
// multiplexing during a cold install, which manifests as a "no version
// matching" resolution failure. The abbreviated form carries everything needed
// to install, and is what package managers want anyway.
const ABBREVIATED_ACCEPT = 'application/vnd.npm.install-v1+json'

// Full packument format. The abbreviated form above omits the per-version
// `time` map by spec, but pnpm's time-based resolution (`minimum-release-age`)
// hard-errors without it (ERR_PNPM_MISSING_TIME). We request the full
// packument ONLY to source `time` (see fetchNpmTime); the served response keeps
// using the compact abbreviated version docs, so it stays small. This fetch is
// server-side (Worker→npm) and edge-cached, so the large full payload never
// reaches a package manager's HTTP/2 client.
const FULL_ACCEPT = 'application/json'

export const NPM_FETCH_TIMEOUT_MS = 5000

/**
 * Bound the complete fetch, including the body read. Cancel npm I/O when this
 * deadline or the enclosing packument budget expires. A timeout is an error,
 * never a missing package that could be cached as a preview-only packument.
 */
async function npmFetchJson(
  env: Env,
  name: string,
  accept: string,
  signal?: AbortSignal,
): Promise<Record<string, any> | null> {
  signal?.throwIfAborted()
  const controller = new AbortController()
  function abort(): void {
    controller.abort(signal?.reason)
  }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    return await withTimeout(fetchMetadata(), NPM_FETCH_TIMEOUT_MS, () => {
      const error = new HttpError(504, `npm metadata request timed out for ${name}`)
      controller.abort(error)
      return error
    })
  } finally {
    signal?.removeEventListener('abort', abort)
  }

  async function fetchMetadata(): Promise<Record<string, any> | null> {
    const res = await fetch(`${env.NPM_REGISTRY}/${encodeNpmPackageName(name)}`, {
      headers: { accept },
      redirect: 'follow',
      signal: controller.signal,
    })
    if (res.status === 404) {
      await res.body?.cancel()
      return null
    }
    if (!res.ok) throw new HttpError(res.status, await res.text())
    return (await res.json()) as Record<string, any>
  }
}

/**
 * Fetch a packument from the npm registry. A 404 (package not published to npm)
 * returns null so the caller can still synthesize a preview-only packument. Any
 * OTHER non-200 is an upstream failure: throw npm's status + raw body, rather
 * than synthesize a misleading packument that drops the package's real versions.
 */
export function fetchNpmPackument(
  env: Env,
  name: string,
  signal?: AbortSignal,
): Promise<Record<string, any> | null> {
  return npmFetchJson(env, name, ABBREVIATED_ACCEPT, signal)
}

/**
 * Fetch ONLY the per-version `time` map from npm's FULL packument. A 404
 * (package not on npm) returns null so the caller can still synthesize a
 * preview-only packument; any OTHER non-200 is an upstream failure and throws
 * npm's status + raw body (so a transient hiccup surfaces as an error instead of
 * a packument missing npm's publish times). A 200 with no usable `time` returns
 * null. Kept separate from fetchNpmPackument so the served response carries the
 * compact abbreviated version docs while still preserving npm's real times.
 */
async function fetchNpmTime(
  env: Env,
  name: string,
  signal: AbortSignal,
): Promise<Record<string, string> | null> {
  const data = await npmFetchJson(env, name, FULL_ACCEPT, signal)
  const time = data?.time
  return time && typeof time === 'object' ? (time as Record<string, string>) : null
}

/** Cached npm `time` TTL: short, only to bound a brand-new version's lag. */
const NPM_TIME_TTL_S = 5 * 60

/**
 * npm's per-version `time` map, cached in KV so the FULL packument (an order of
 * magnitude larger than the abbreviated one, e.g. ~1.4 MB for vite-plus) is
 * fetched and parsed rarely instead of on every request, the dominant hot-path
 * allocation. KV's native TTL bounds how long a brand-new npm version's time
 * lags, and such a version is younger than any minimum-release-age threshold (so
 * a momentarily-absent entry is filtered out, not an ERR_PNPM_MISSING_TIME).
 * Refs/versions stay fresh (read live), so this adds no publish-visibility lag.
 * KV, not the Cache API, because the Void runtime forbids `caches.default`.
 */
export async function getNpmTimeCached(
  env: Env,
  name: string,
  work: RequestWork,
): Promise<Record<string, string>> {
  // The fetcher returns the small EXTRACTED map (not the multi-MB body), and `{}`
  // for a 404 so a not-on-npm package is cached and not re-fetched in full every
  // request.
  const time = await kvCached(
    env,
    `npm-time/${name}`,
    NPM_TIME_TTL_S,
    () =>
      work.timing.measure(
        'npm.time',
        async () => (await fetchNpmTime(env, name, work.signal)) ?? {},
      ),
    work,
  )
  return time ?? {}
}

/** Cached abbreviated packument TTL: matches the served `cache-control` window. */
const NPM_PACKUMENT_TTL_S = 5 * 60

/**
 * The abbreviated npm packument, cached in KV. The Void runtime does NOT
 * edge-cache the assembled packument response (it forbids the Cache API), so
 * without this every fresh client, e.g. each CI install, re-fetched the full
 * abbreviated packument from npm cross-network, the dominant hot-path latency.
 * Only npm-published versions are cached; preview versions are injected live
 * from the refs index, so a newly published preview still appears immediately
 * (the cache adds no publish-visibility lag, only an npm stable release lags up
 * to the TTL, which the served `max-age=300` already allows). A 404 (not on npm)
 * returns null and is left uncached so it stays cheap to re-probe.
 */
export function getNpmPackumentCached(
  env: Env,
  name: string,
  work: RequestWork,
): Promise<Record<string, any> | null> {
  return kvCached(
    env,
    `npm-packument/${name}`,
    NPM_PACKUMENT_TTL_S,
    () => work.timing.measure('npm.packument', () => fetchNpmPackument(env, name, work.signal)),
    work,
  )
}
