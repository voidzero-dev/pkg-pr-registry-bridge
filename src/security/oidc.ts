/**
 * GitHub Actions OIDC verification for the publish endpoints (RFC 0002).
 *
 * The bridge accepts a short-lived, GitHub-signed identity token instead of a
 * shared secret, so a consumer repo stores no bridge credential and fork PRs
 * can publish through a separate `workflow_run` workflow. Nothing here is
 * secret: the signing key is GitHub's public JWKS and the allowlists hold
 * public identifiers.
 *
 * Verification is hand-rolled on WebCrypto rather than pulled from a JWT
 * library (the Worker avoids heavy deps), which means owning the standard
 * pitfalls explicitly:
 *
 *  - RS256 is pinned in code. The `alg` in the token header is never used to
 *    select an algorithm; a token claiming `none` or an HMAC variant is
 *    rejected before any key is loaded. Trusting that header is a full
 *    authentication bypass.
 *  - The verification key is selected by `kid` from the fetched JWKS, never
 *    from anything else the token carries.
 *  - Every length is capped before parsing or crypto runs, because the token
 *    is entirely attacker-supplied on an internet-facing endpoint.
 *  - Identity is anchored on the immutable numeric `repository_id` /
 *    `repository_owner_id`, not only on `workflow_ref`: that claim embeds a
 *    repository *name*, and names can be renamed, transferred, or released
 *    and reclaimed by someone else.
 */
import type { Env } from '../config'
import { HttpError } from '../httpError'

export const GITHUB_OIDC_ISSUER = 'https://token.actions.githubusercontent.com'
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`

// Parse bounds. A real GitHub OIDC token is ~1.5KB; these leave generous room
// while keeping a hostile body from driving allocation or base64 work.
const MAX_TOKEN_CHARS = 8192
const MAX_HEADER_CHARS = 1024
const MAX_PAYLOAD_CHARS = 8192
const MAX_KID_CHARS = 200

/** Tolerance for runner/edge clock drift on exp/nbf/iat. */
const CLOCK_SKEW_S = 60

const JWKS_KV_KEY = 'oidc:jwks'
const JWKS_TTL_S = 6 * 60 * 60
// Cooldown guarding the unknown-`kid` refetch, so a stream of bogus `kid`
// values cannot turn a cheap 401 into unbounded outbound fetches. 60s is KV's
// minimum expirationTtl.
const JWKS_REFETCH_COOLDOWN_KEY = 'oidc:jwks:cooldown'
const JWKS_REFETCH_COOLDOWN_S = 60

/**
 * What a verified token tells the caller.
 *
 * Only the claims that carry information survive verification. `iss`, `aud`,
 * `repository_id` and `repository_owner_id` are checked against fixed values,
 * so echoing them back would hand callers a constant dressed as data.
 */
export interface OidcClaims {
  /** `<owner>/<repo>` at mint time. Mutable; used only for prUrl scoping. */
  repository: string
  /** The allowlisted workflow that minted this, for logs and error messages. */
  workflow_ref: string
}

/** Resolved OIDC config, or null when the OIDC path is switched off. */
interface OidcConfig {
  audience: string
  workflows: string[]
  repositoryId: string
  ownerId: string
}

type Jwk = { kid?: string; kty?: string; n?: string; e?: string }

/**
 * Per-isolate memo for the JWKS and the imported keys.
 *
 * A publish run is ~23 authenticated requests (one per tarball upload, one per
 * /-/publish, one /-/register), all verified with the same unchanging key. KV
 * is already a cache, but reading and re-parsing it per request, then calling
 * `importKey` again on the same modulus, is work the isolate can skip entirely.
 * Workers reuse an isolate across requests, so this collapses to roughly one KV
 * read per isolate. Both values are a few KB and capture nothing large.
 */
let jwksMemo: { keys: Jwk[]; at: number } | null = null
const keyMemo = new Map<string, CryptoKey>()
const JWKS_MEMO_TTL_MS = 5 * 60 * 1000

/**
 * Resolve the OIDC config, or null when it is entirely unset (admin-token-only
 * deployment). A partial config throws rather than silently disabling the path:
 * SR-7 requires the repository ids whenever a workflow allowlist exists, and a
 * half-configured bridge that quietly rejects every token is hard to diagnose.
 */
export function getOidcConfig(env: Env): OidcConfig | null {
  const audience = env.OIDC_AUDIENCE?.trim() ?? ''
  const workflows = (env.OIDC_TRUSTED_WORKFLOWS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const repositoryId = env.OIDC_TRUSTED_REPOSITORY_ID?.trim() ?? ''
  const ownerId = env.OIDC_TRUSTED_OWNER_ID?.trim() ?? ''

  const present = [audience, workflows.length ? 'y' : '', repositoryId, ownerId]
  if (present.every((v) => !v)) return null
  if (present.some((v) => !v)) {
    throw new HttpError(
      503,
      'OIDC publishing is misconfigured: OIDC_AUDIENCE, OIDC_TRUSTED_WORKFLOWS, ' +
        'OIDC_TRUSTED_REPOSITORY_ID and OIDC_TRUSTED_OWNER_ID must all be set',
    )
  }
  return { audience, workflows, repositoryId, ownerId }
}

/**
 * Does this bearer value look like a JWT? Used only to route between the OIDC
 * and admin-token paths, never as a security decision: a value that looks like
 * a JWT still has to verify, and one that does not still has to match the admin
 * token in constant time.
 */
export function looksLikeJwt(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 3 && parts.every((p) => p.length > 0)
}

/** Strict Base64URL: rejects padding, whitespace and any non-alphabet byte. */
function base64UrlToBytes(segment: string, label: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) {
    throw new HttpError(401, `Malformed token (${label} is not base64url)`)
  }
  const b64 = segment.replaceAll('-', '+').replaceAll('_', '/')
  // atob wants canonical padding; segment length %4 === 1 is never valid.
  const pad = b64.length % 4
  if (pad === 1) throw new HttpError(401, `Malformed token (${label} length)`)
  let binary: string
  try {
    binary = atob(pad ? b64 + '='.repeat(4 - pad) : b64)
  } catch {
    // Defensive: the charset test and the length check above should already
    // exclude everything atob rejects, so this is not reachable today. It is
    // here so a future change to either check cannot turn a bad token into a
    // 500, which is exactly how the UTF-8 case below reached production.
    throw new HttpError(401, `Malformed token (${label} is not base64url)`)
  }
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function decodeJsonSegment(
  segment: string,
  maxChars: number,
  label: string,
): Record<string, unknown> {
  if (segment.length > maxChars) {
    throw new HttpError(401, `Malformed token (${label} too large)`)
  }
  // `fatal` so invalid UTF-8 throws instead of silently becoming U+FFFD inside
  // a claim value. It throws a plain TypeError, so it has to be converted here:
  // letting it escape turns a garbage token into a 500 rather than a 401.
  // Base64url's alphabet says nothing about whether the bytes are valid UTF-8,
  // so this is reachable from any well-formed-looking segment.
  const bytes = base64UrlToBytes(segment, label)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)
  } catch {
    throw new HttpError(401, `Malformed token (${label} is not valid UTF-8)`)
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new HttpError(401, `Malformed token (${label} is not JSON)`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(401, `Malformed token (${label} is not an object)`)
  }
  return parsed as Record<string, unknown>
}

/** Read a claim that must be a non-empty string. Numbers are NOT coerced. */
function stringClaim(claims: Record<string, unknown>, name: string): string {
  const value = claims[name]
  if (typeof value !== 'string' || value === '') {
    throw new HttpError(401, `Token is missing the ${name} claim`)
  }
  return value
}

/** Read a claim that must be a finite number. Strings are NOT coerced. */
function numberClaim(claims: Record<string, unknown>, name: string): number {
  const value = claims[name]
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(401, `Token is missing the ${name} claim`)
  }
  return value
}

/**
 * `aud` is a string or an array of strings per RFC 7519. This bridge mints
 * single-audience tokens, so a multi-audience token is rejected rather than
 * scanned for a match: accepting one would let a token shared with another
 * service authorize a publish here.
 */
function audienceClaim(claims: Record<string, unknown>): string {
  const value = claims.aud
  if (typeof value === 'string' && value !== '') return value
  if (Array.isArray(value) && value.length === 1 && typeof value[0] === 'string') {
    return value[0]
  }
  throw new HttpError(401, 'Token is missing a single-valued aud claim')
}

async function fetchJwks(): Promise<Jwk[]> {
  const res = await fetch(JWKS_URL, { headers: { accept: 'application/json' } })
  if (!res.ok) throw new Error(`JWKS fetch failed: HTTP ${res.status}`)
  const body = (await res.json()) as { keys?: unknown }
  if (!Array.isArray(body.keys)) throw new Error('JWKS has no keys array')
  return body.keys as Jwk[]
}

/**
 * Find the signing key for `kid`, from KV or from GitHub. An unknown `kid` is
 * usually key rotation, so one refetch is attempted; the cooldown keeps that
 * from being a free amplification path for forged `kid` values.
 */
async function findKey(env: Env, kid: string): Promise<Jwk> {
  let keys: Jwk[] | null = null
  if (jwksMemo && Date.now() - jwksMemo.at < JWKS_MEMO_TTL_MS) {
    keys = jwksMemo.keys
  } else {
    try {
      keys = await env.KV.get<Jwk[]>(JWKS_KV_KEY, 'json')
      if (keys) jwksMemo = { keys, at: Date.now() }
    } catch (err) {
      console.warn('JWKS cache read failed:', err)
    }
  }

  const hit = keys?.find((k) => k.kid === kid)
  if (hit) return hit

  let cooling = false
  try {
    cooling = keys != null && (await env.KV.get(JWKS_REFETCH_COOLDOWN_KEY)) !== null
  } catch (err) {
    console.warn('JWKS cooldown read failed:', err)
  }
  if (cooling) throw new HttpError(401, 'Unknown token signing key')

  const fresh = await fetchJwks().catch((err) => {
    console.warn('JWKS fetch failed:', err)
    return null
  })
  if (!fresh) throw new HttpError(503, 'Cannot reach the OIDC signing keys')

  jwksMemo = { keys: fresh, at: Date.now() }
  keyMemo.clear()
  try {
    // Independent writes; no reason to serialize them.
    await Promise.all([
      env.KV.put(JWKS_KV_KEY, JSON.stringify(fresh), { expirationTtl: JWKS_TTL_S }),
      env.KV.put(JWKS_REFETCH_COOLDOWN_KEY, '1', {
        expirationTtl: JWKS_REFETCH_COOLDOWN_S,
      }),
    ])
  } catch (err) {
    console.warn('JWKS cache write failed:', err)
  }

  const found = fresh.find((k) => k.kid === kid)
  if (!found) throw new HttpError(401, 'Unknown token signing key')
  return found
}

async function verifySignature(
  jwk: Jwk,
  signingInput: string,
  signature: Uint8Array,
): Promise<boolean> {
  if (jwk.kty !== 'RSA' || !jwk.n || !jwk.e) {
    throw new HttpError(401, 'Unusable token signing key')
  }
  // RS256 is hardcoded on both the import and the verify. The token header is
  // never consulted for either. Keyed by the modulus rather than `kid`, so a
  // rotated key reusing a `kid` cannot hit a stale entry.
  let key = keyMemo.get(jwk.n)
  if (!key) {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    keyMemo.set(jwk.n, key)
  }
  return crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as unknown as BufferSource,
    new TextEncoder().encode(signingInput) as unknown as BufferSource,
  )
}

/**
 * Verify a GitHub Actions OIDC token and return its claims. Throws HttpError
 * on any failure; callers surface it as-is.
 */
export async function verifyOidcToken(
  env: Env,
  token: string,
  config: OidcConfig,
): Promise<OidcClaims> {
  if (token.length > MAX_TOKEN_CHARS) {
    throw new HttpError(401, 'Malformed token (too large)')
  }
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new HttpError(401, 'Malformed token (expected three segments)')
  }
  const [headerSeg, payloadSeg, signatureSeg] = parts
  if (!headerSeg || !payloadSeg || !signatureSeg) {
    throw new HttpError(401, 'Malformed token (empty segment)')
  }

  const header = decodeJsonSegment(headerSeg, MAX_HEADER_CHARS, 'header')
  // Reject a non-RS256 header early. The verify below pins RS256 regardless,
  // so this is a clearer error rather than the thing keeping us safe.
  if (header.alg !== 'RS256') {
    throw new HttpError(401, 'Unsupported token algorithm')
  }
  const kid = header.kid
  if (typeof kid !== 'string' || !kid || kid.length > MAX_KID_CHARS) {
    throw new HttpError(401, 'Malformed token (kid)')
  }

  const jwk = await findKey(env, kid)
  const ok = await verifySignature(
    jwk,
    `${headerSeg}.${payloadSeg}`,
    base64UrlToBytes(signatureSeg, 'signature'),
  )
  if (!ok) throw new HttpError(401, 'Token signature is invalid')

  // Only now is the payload trustworthy enough to act on.
  const claims = decodeJsonSegment(payloadSeg, MAX_PAYLOAD_CHARS, 'payload')

  if (stringClaim(claims, 'iss') !== GITHUB_OIDC_ISSUER) {
    throw new HttpError(401, 'Token issuer is not GitHub Actions')
  }

  const now = Math.floor(Date.now() / 1000)
  if (numberClaim(claims, 'exp') <= now - CLOCK_SKEW_S) {
    throw new HttpError(401, 'Token has expired')
  }
  for (const name of ['nbf', 'iat'] as const) {
    const value = claims[name]
    if (typeof value === 'number' && value > now + CLOCK_SKEW_S) {
      throw new HttpError(401, `Token is not yet valid (${name})`)
    }
  }

  if (audienceClaim(claims) !== config.audience) {
    throw new HttpError(401, 'Token audience does not match this bridge')
  }

  // Immutable identity first (SR-7), then the workflow-level restriction.
  if (stringClaim(claims, 'repository_id') !== config.repositoryId) {
    throw new HttpError(403, 'Token is not from the trusted repository')
  }
  if (stringClaim(claims, 'repository_owner_id') !== config.ownerId) {
    throw new HttpError(403, 'Token is not from the trusted repository owner')
  }
  const workflowRef = stringClaim(claims, 'workflow_ref')
  // Exact match. `workflow_ref` names the calling workflow; if the publish step
  // ever moves into a reusable workflow, the claim to pin becomes
  // `job_workflow_ref` and this check must be revisited.
  if (!config.workflows.includes(workflowRef)) {
    throw new HttpError(403, 'Token is not from a trusted workflow')
  }

  return { repository: stringClaim(claims, 'repository'), workflow_ref: workflowRef }
}
