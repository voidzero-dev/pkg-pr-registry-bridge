import type { Env } from '../config'
import { encodeNpmPackageName } from './parsePackageName'
import { HttpError } from '../httpError'
import { npmTimeCacheControl } from '../cache/headers'

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

/** GET a package's metadata from the npm registry with the given Accept header. */
function npmFetch(env: Env, name: string, accept: string): Promise<Response> {
  return fetch(`${env.NPM_REGISTRY}/${encodeNpmPackageName(name)}`, {
    headers: { accept },
    redirect: 'follow',
  })
}

/**
 * Surface an npm upstream failure: throw npm's status + raw body on a non-2xx
 * response. Callers handle 404 themselves first, since "not on npm" is not a
 * failure.
 */
async function assertNpmOk(res: Response): Promise<void> {
  if (!res.ok) throw new HttpError(res.status, await res.text())
}

/**
 * Fetch a packument from the npm registry. A 404 (package not published to npm)
 * returns null so the caller can still synthesize a preview-only packument. Any
 * OTHER non-200 is an upstream failure: throw npm's status + raw body, rather
 * than synthesize a misleading packument that drops the package's real versions.
 */
export async function fetchNpmPackument(
  env: Env,
  name: string,
): Promise<Record<string, any> | null> {
  const res = await npmFetch(env, name, ABBREVIATED_ACCEPT)

  if (res.status === 404) return null
  await assertNpmOk(res)

  return (await res.json()) as Record<string, any>
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
): Promise<Record<string, string> | null> {
  const res = await npmFetch(env, name, FULL_ACCEPT)

  if (res.status === 404) return null
  await assertNpmOk(res)

  const data = (await res.json()) as Record<string, any>
  const time = data?.time
  return time && typeof time === 'object'
    ? (time as Record<string, string>)
    : null
}

/**
 * npm's per-version `time` map, cached per-colo so the FULL packument (an order
 * of magnitude larger than the abbreviated one, e.g. ~1.4 MB for vite-plus) is
 * fetched and parsed rarely instead of on every request, the dominant hot-path
 * allocation. Past versions' times are immutable; the short TTL only bounds how
 * long a brand-new npm version's time lags, and such a version is younger than
 * any minimum-release-age threshold (so a momentarily-absent entry is filtered
 * out, not an ERR_PNPM_MISSING_TIME). Refs/versions stay fresh (read live), so
 * this adds no publish-visibility lag.
 */
export async function getNpmTimeCached(
  env: Env,
  name: string,
  // Structural so this stays decoupled from Hono's vs Cloudflare's
  // `ExecutionContext` types (which differ); both have `waitUntil`.
  ctx: { waitUntil(promise: Promise<unknown>): void },
): Promise<Record<string, string>> {
  const key = new Request(
    `${env.PUBLIC_BASE_URL}/-/npm-time/${encodeNpmPackageName(name)}`,
  )
  const hit = await caches.default.match(key)
  if (hit) return (await hit.json()) as Record<string, string>

  // Store the small EXTRACTED map (not the multi-MB body); `{}` for a 404 so a
  // not-on-npm package isn't re-fetched in full every request.
  const time = (await fetchNpmTime(env, name)) ?? {}
  ctx.waitUntil(
    caches.default.put(
      key,
      new Response(JSON.stringify(time), {
        headers: {
          'content-type': 'application/json',
          'cache-control': npmTimeCacheControl(),
        },
      }),
    ),
  )
  return time
}
