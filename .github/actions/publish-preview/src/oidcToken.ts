/**
 * Mint GitHub Actions OIDC tokens for the bridge (RFC 0002).
 *
 * The runner exposes a token-minting endpoint to any job granted
 * `permissions: id-token: write`. Requesting a token with the bridge as
 * audience proves "this workflow, in this repository, ran this" without the
 * repository storing a bridge credential, which is what lets fork PRs publish
 * through the trusted `workflow_run` leg.
 *
 * Reads the runner environment directly rather than depending on
 * `@actions/core`, keeping the bundled action free of runtime deps.
 */

/** Re-mint a little before GitHub's ~5 minute lifetime is up. */
const REFRESH_AFTER_MS = 4 * 60 * 1000

const REQUEST_TIMEOUT_MS = 15_000

export interface TokenMinter {
  /** The `Authorization` header value to send, minting or reusing as needed. */
  header(): Promise<string>
  /** Drop any cached token, so the next call mints fresh (used after a 401). */
  invalidate(): void
}

/** A minter that returns a fixed operator token. */
export function staticToken(token: string): TokenMinter {
  const header = `Bearer ${token}`
  return { header: async () => header, invalidate: () => {} }
}

/**
 * A minter backed by the runner's OIDC endpoint.
 *
 * The token is cached and re-minted once it approaches expiry, so a publish
 * that stalls part-way (a slow upload, a retry backoff) never sends a token
 * that expired while it waited, without minting one per HTTP attempt.
 */
export function oidcMinter(audience: string): TokenMinter {
  let cached: { header: string; mintedAt: number } | null = null

  return {
    async header(): Promise<string> {
      if (cached && Date.now() - cached.mintedAt < REFRESH_AFTER_MS) {
        return cached.header
      }
      const token = await mintOidcToken(audience)
      cached = { header: `Bearer ${token}`, mintedAt: Date.now() }
      return cached.header
    },
    invalidate(): void {
      cached = null
    },
  }
}

/** Request one OIDC token for `audience` from the runner. */
export async function mintOidcToken(audience: string): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL
  const runtimeToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN
  if (!url || !runtimeToken) {
    throw new Error(
      'no OIDC token available: the job needs `permissions: id-token: write`. ' +
        'Note that pull_request runs from forks are never granted it, which is ' +
        'why publishing runs in a separate workflow_run job.',
    )
  }

  const requestUrl = `${url}&audience=${encodeURIComponent(audience)}`
  const res = await fetch(requestUrl, {
    headers: { authorization: `Bearer ${runtimeToken}` },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) {
    throw new Error(`OIDC token request failed: HTTP ${res.status}`)
  }
  const body = (await res.json()) as { value?: unknown }
  if (typeof body.value !== 'string' || !body.value) {
    throw new Error('OIDC token response had no value')
  }
  return body.value
}
