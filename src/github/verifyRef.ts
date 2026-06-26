import type { Env } from '../config'
import type { ConfiguredPreviewRef } from '../preview/parseConfiguredPreviewRefs'

/**
 * Check that a preview ref actually exists in the configured GitHub repo:
 * a PR number resolves to a pull request, a commit sha to a commit. Uses
 * `GITHUB_TOKEN` when set (required for private repos and higher rate limits).
 *
 * Returns true if the ref exists, false on a 404. Other upstream failures
 * throw so the caller can decide whether to fail open or closed.
 */
export async function verifyRefExists(
  env: Env,
  ref: ConfiguredPreviewRef,
): Promise<boolean> {
  const base = `https://api.github.com/repos/${env.PREVIEW_OWNER}/${env.PREVIEW_REPO}`
  const path = ref.type === 'pr' ? `/pulls/${ref.ref}` : `/commits/${ref.ref}`

  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'pkg-pr-registry-bridge',
    'x-github-api-version': '2022-11-28',
  }
  if (env.GITHUB_TOKEN) headers.authorization = `Bearer ${env.GITHUB_TOKEN}`

  const res = await fetch(base + path, { headers })
  if (res.status === 404) return false
  if (!res.ok) {
    throw new Error(`GitHub API error ${res.status} for ${path}`)
  }
  return true
}
