import type { Env } from '../config'
import { HttpError } from '../httpError'
import { timingSafeEqual } from './timingSafeEqual'
import { getOidcConfig, looksLikeJwt, verifyOidcToken, type OidcClaims } from './oidc'

interface AuthInput {
  env: { ADMIN_TOKEN?: string }
  authorization: string | undefined
}

/** Who is making a write request. */
export type Publisher = { kind: 'admin' } | { kind: 'oidc'; claims: OidcClaims }

function bearer(authorization: string | undefined): string {
  return (authorization ?? '').replace(/^Bearer\s+/i, '')
}

/**
 * Guard the admin-only endpoints (`/-/purge`). Requires
 * `Authorization: Bearer <ADMIN_TOKEN>`. Returns 503 when no admin token is
 * configured (admin disabled), 401 otherwise.
 *
 * Deletion stays on the operator token deliberately: an OIDC identity may add
 * preview builds and nothing else.
 */
export function requireAdmin({ env, authorization }: AuthInput): void {
  if (!env.ADMIN_TOKEN) {
    throw new HttpError(503, 'Admin endpoints are not configured')
  }
  const provided = bearer(authorization)
  if (!provided || !timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    throw new HttpError(401, 'Unauthorized')
  }
}

/**
 * Guard the publish endpoints (tarball upload, `/-/publish`, `/-/register`).
 * Accepts either the operator's admin token or a GitHub Actions OIDC token
 * (RFC 0002), and reports which one so callers can apply the tighter rules
 * that only make sense for a CI identity.
 *
 * The JWT/admin routing is on shape alone and decides nothing: a JWT-shaped
 * value still has to verify against GitHub's JWKS, and anything else still has
 * to match the admin token in constant time.
 */
export async function requirePublisher({
  env,
  authorization,
}: {
  env: Env
  authorization: string | undefined
}): Promise<Publisher> {
  const provided = bearer(authorization)
  // Throws 503 on a half-configured OIDC setup, so a deployment missing (say)
  // the repository id fails loudly instead of rejecting every token as 401.
  const oidc = getOidcConfig(env)

  if (!env.ADMIN_TOKEN && !oidc) {
    throw new HttpError(503, 'Publishing is not configured')
  }
  if (!provided) throw new HttpError(401, 'Unauthorized')

  // Try the operator token FIRST, in constant time. Shape must not decide which
  // credential a value is: an ADMIN_TOKEN that happens to contain three
  // dot-separated segments would otherwise be routed into OIDC verification and
  // rejected, breaking every publish and `pnpm warm` while still working on
  // /-/purge, which compares it directly.
  if (env.ADMIN_TOKEN && timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    return { kind: 'admin' }
  }
  if (oidc && looksLikeJwt(provided)) {
    return { kind: 'oidc', claims: await verifyOidcToken(env, provided, oidc) }
  }
  throw new HttpError(401, 'Unauthorized')
}

/**
 * Scope a `prUrl` to the repository the token was minted for, so a CI identity
 * cannot register a ref pointing at a pull request in some other repository.
 *
 * This is a containment check, not the real binding. The authoritative one is
 * in the publishing workflow, which resolves the PR from the triggering run's
 * head branch via the GitHub API and constructs the URL itself, so the value
 * never comes from the (untrusted) build artifact. The bridge cannot repeat
 * that lookup without a GitHub API dependency, so it enforces the containment
 * it can.
 */
export function assertPrUrlInRepository(prUrl: string, publisher: Publisher): void {
  if (publisher.kind !== 'oidc') return
  const expected = `https://github.com/${publisher.claims.repository}/pull/`
  if (!prUrl.startsWith(expected)) {
    throw new HttpError(403, `prUrl must be a pull request of ${publisher.claims.repository}`)
  }
}
