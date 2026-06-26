import type { Env } from '../config'
import { encodeNpmPackageName } from './parsePackageName'

export interface NpmPackumentResult {
  status: number
  /** Parsed packument, or null when the upstream had no usable body. */
  data: Record<string, any> | null
}

/**
 * Fetch a packument from the npm registry. A 404 (package not published to
 * npm) is returned as `{ status: 404, data: null }` so the caller can still
 * synthesize a preview-only packument.
 */
export async function fetchNpmPackument(
  env: Env,
  name: string,
  accept: string,
): Promise<NpmPackumentResult> {
  const res = await fetch(`${env.NPM_REGISTRY}/${encodeNpmPackageName(name)}`, {
    headers: { accept },
    redirect: 'follow',
  })

  if (res.status === 404) return { status: 404, data: null }
  if (!res.ok) return { status: res.status, data: null }

  const data = (await res.json()) as Record<string, any>
  return { status: 200, data }
}
