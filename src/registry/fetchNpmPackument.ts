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
