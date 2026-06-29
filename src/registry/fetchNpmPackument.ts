import type { Env } from '../config'
import { encodeNpmPackageName } from './parsePackageName'

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

/**
 * Fetch a packument from the npm registry. A 404 (package not published to
 * npm) is returned as `{ status: 404, data: null }` so the caller can still
 * synthesize a preview-only packument.
 */
export async function fetchNpmPackument(
  env: Env,
  name: string,
): Promise<NpmPackumentResult> {
  const res = await fetch(`${env.NPM_REGISTRY}/${encodeNpmPackageName(name)}`, {
    headers: { accept: ABBREVIATED_ACCEPT },
    redirect: 'follow',
  })

  if (res.status === 404) return { status: 404, data: null }
  if (!res.ok) return { status: res.status, data: null }

  const data = (await res.json()) as Record<string, any>
  return { status: 200, data }
}

/**
 * Fetch ONLY the per-version `time` map from npm's FULL packument. Returns null
 * when the package is absent (404) or the upstream omits/has no usable `time`,
 * so the caller can still serve a synthesized packument (with `time` entries it
 * fills in for the injected preview versions). Keeping this separate from
 * fetchNpmPackument lets the served response carry the compact abbreviated
 * version docs while still preserving npm's real publish times.
 */
export async function fetchNpmTime(
  env: Env,
  name: string,
): Promise<Record<string, string> | null> {
  // Fail soft: a hiccup sourcing `time` must not break the packument. On any
  // error return null and serve without npm's times (the injected preview
  // versions still get their own `time` entry from the caller).
  try {
    const res = await fetch(`${env.NPM_REGISTRY}/${encodeNpmPackageName(name)}`, {
      headers: { accept: FULL_ACCEPT },
      redirect: 'follow',
    })

    if (!res.ok) return null

    const data = (await res.json()) as Record<string, any>
    const time = data?.time
    return time && typeof time === 'object'
      ? (time as Record<string, string>)
      : null
  } catch {
    return null
  }
}
