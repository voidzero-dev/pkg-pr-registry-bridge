import type { Env } from '../config'
import { encodeNpmPackageName } from './parsePackageName'
import { HttpError } from '../httpError'

export interface NpmPackumentResult {
  status: number
  /** Parsed packument, or null when the upstream had no usable body. */
  data: Record<string, any> | null
}

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
 * Fetch a packument from the npm registry. A 404 (package not published to npm)
 * is returned as `{ status: 404, data: null }` so the caller can still
 * synthesize a preview-only packument. Any OTHER non-200 is an upstream failure:
 * throw npm's status + raw body, rather than synthesize a misleading packument
 * that drops the package's real versions.
 */
export async function fetchNpmPackument(
  env: Env,
  name: string,
): Promise<NpmPackumentResult> {
  const res = await npmFetch(env, name, ABBREVIATED_ACCEPT)

  if (res.status === 404) return { status: 404, data: null }
  if (!res.ok) throw new HttpError(res.status, await res.text())

  const data = (await res.json()) as Record<string, any>
  return { status: 200, data }
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
export async function fetchNpmTime(
  env: Env,
  name: string,
): Promise<Record<string, string> | null> {
  const res = await npmFetch(env, name, FULL_ACCEPT)

  if (res.status === 404) return null
  if (!res.ok) throw new HttpError(res.status, await res.text())

  const data = (await res.json()) as Record<string, any>
  const time = data?.time
  return time && typeof time === 'object'
    ? (time as Record<string, string>)
    : null
}
