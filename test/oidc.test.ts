/**
 * OIDC publish-path tests (RFC 0002).
 *
 * A locally generated RSA key stands in for GitHub's signing key: the JWKS
 * endpoint is stubbed to serve its public half, so tokens can be minted with
 * arbitrary claims and the real verifier runs unmodified.
 *
 * The negative cases are the point. Each one corresponds to a way the verifier
 * could be wrong in a way that still passes a happy-path test: `alg: none`
 * acceptance, header-driven algorithm selection, a token from another
 * repository that happens to carry the right workflow path, a renamed
 * repository reusing a trusted name, and prUrl values that would move another
 * PR's dist-tag.
 */
import { SELF, env } from 'cloudflare:test'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GITHUB_OIDC_ISSUER, verifyOidcToken } from '../src/security/oidc'
import type { Env } from '../src/config'

const BASE = 'https://bridge.example.com'
const AUDIENCE = 'https://bridge.example.com'
const REPOSITORY = 'voidzero-dev/vite-plus'
const REPOSITORY_ID = '778899'
const OWNER_ID = '112233'
const TRUSTED_WORKFLOW =
  'voidzero-dev/vite-plus/.github/workflows/publish-preview-register.yml@refs/heads/main'

const KID = 'test-key-1'
const JWKS_URL = `${GITHUB_OIDC_ISSUER}/.well-known/jwks`

let signingKey: CryptoKey
let publicJwk: Record<string, unknown>
let jwksFetches = 0

function b64url(bytes: Uint8Array | string): string {
  const arr =
    typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes
  let binary = ''
  for (const b of arr) binary += String.fromCharCode(b)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

type Claims = Record<string, unknown>

/** Mint a token signed by the fixture key, with overridable claims/header. */
async function mint(
  claims: Claims = {},
  header: Record<string, unknown> = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const payload: Claims = {
    iss: GITHUB_OIDC_ISSUER,
    aud: AUDIENCE,
    exp: now + 300,
    iat: now,
    nbf: now,
    repository: REPOSITORY,
    repository_id: REPOSITORY_ID,
    repository_owner_id: OWNER_ID,
    workflow_ref: TRUSTED_WORKFLOW,
    sub: `repo:${REPOSITORY}:ref:refs/heads/main`,
    ...claims,
  }
  const signingInput = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID, ...header }))}.${b64url(JSON.stringify(payload))}`
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signingKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64url(new Uint8Array(sig))}`
}

/** A token whose signature is valid but produced by a DIFFERENT key. */
async function mintWithForeignKey(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  const now = Math.floor(Date.now() / 1000)
  const signingInput =
    `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))}.` +
    b64url(
      JSON.stringify({
        iss: GITHUB_OIDC_ISSUER,
        aud: AUDIENCE,
        exp: now + 300,
        repository: REPOSITORY,
        repository_id: REPOSITORY_ID,
        repository_owner_id: OWNER_ID,
        workflow_ref: TRUSTED_WORKFLOW,
      }),
    )
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    pair.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${b64url(new Uint8Array(sig))}`
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair
  signingKey = pair.privateKey
  const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey
  publicJwk = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', use: 'sig', kid: KID }

  vi.stubGlobal('fetch', (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()
    if (url === JWKS_URL) {
      jwksFetches++
      return Promise.resolve(
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { 'content-type': 'application/json' },
        }),
      )
    }
    if (url.startsWith('https://registry.npmjs.org/')) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'nope' }), { status: 404 }))
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  })
})

afterAll(() => vi.unstubAllGlobals())

beforeEach(async () => {
  jwksFetches = 0
  // The pool isolates storage per test, but KV carries the JWKS cache; clear it
  // so refetch behaviour is observable.
  await env.KV.delete('oidc:jwks')
  await env.KV.delete('oidc:jwks:cooldown')
})

function post(path: string, body: unknown, token: string): Promise<Response> {
  return SELF.fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })
}

const SHA = 'b'.repeat(40)
const VERSION = `0.0.0-commit.${SHA}`

function publishBody(ref = `commit.${SHA}`) {
  return {
    ref,
    packages: [
      {
        name: 'vite-plus',
        version: VERSION,
        packageJson: { name: 'vite-plus', version: VERSION },
        integrity: 'sha512-deadbeef',
        shasum: 'a'.repeat(40),
      },
    ],
  }
}

describe('OIDC publishing: accepted', () => {
  it('publishes with a valid token', async () => {
    const res = await post('/-/publish', publishBody(), await mint())
    expect(res.status).toBe(201)
  })

  it('uploads a tarball with a valid token', async () => {
    const res = await SELF.fetch(
      `${BASE}/-/tarball/vite-plus/${VERSION}/${'a'.repeat(40)}.tgz`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${await mint()}` },
        body: new Uint8Array([1, 2, 3]),
      },
    )
    expect(res.status).toBe(201)
  })

  it('registers a ref whose prUrl is in the token repository', async () => {
    const res = await post(
      '/-/register',
      { ref: `commit.${SHA}`, prUrl: `https://github.com/${REPOSITORY}/pull/42` },
      await mint(),
    )
    expect(res.status).toBe(201)
  })

  it('still accepts the admin token on the publish endpoints', async () => {
    const res = await post('/-/publish', publishBody(), 'test-admin-token')
    expect(res.status).toBe(201)
  })

  it('does not refetch the JWKS per request', async () => {
    // A publish run is ~23 authenticated requests sharing one key. Warm the
    // isolate first, then assert the steady state is ZERO outbound fetches:
    // the JWKS and the imported key are memoized per isolate, so clearing the
    // KV copy in beforeEach no longer forces a refetch.
    await post('/-/publish', publishBody(), await mint())
    jwksFetches = 0
    await post('/-/publish', publishBody(), await mint())
    await post('/-/publish', publishBody(), await mint())
    expect(jwksFetches).toBe(0)
  })
})

describe('OIDC publishing: rejected tokens', () => {
  const cases: Array<[string, () => Promise<string> | string, number]> = [
    [
      'alg: none with an empty signature',
      () => {
        const now = Math.floor(Date.now() / 1000)
        return (
          `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }))}.` +
          `${b64url(JSON.stringify({ iss: GITHUB_OIDC_ISSUER, aud: AUDIENCE, exp: now + 300, repository: REPOSITORY, repository_id: REPOSITORY_ID, repository_owner_id: OWNER_ID, workflow_ref: TRUSTED_WORKFLOW }))}.` +
          'AA'
        )
      },
      401,
    ],
    ['HS256 header', () => mint({}, { alg: 'HS256' }), 401],
    ['signature from an untrusted key', () => mintWithForeignKey(), 401],
    ['expired', () => mint({ exp: Math.floor(Date.now() / 1000) - 3600 }), 401],
    ['wrong issuer', () => mint({ iss: 'https://evil.example.com' }), 401],
    ['wrong audience', () => mint({ aud: 'https://other.example.com' }), 401],
    [
      'multi-valued audience including ours',
      () => mint({ aud: [AUDIENCE, 'https://other.example.com'] }),
      401,
    ],
    ['unlisted workflow_ref', () => mint({ workflow_ref: `${REPOSITORY}/.github/workflows/evil.yml@refs/heads/main` }), 403],
    [
      'build-workflow workflow_ref',
      () => mint({ workflow_ref: `${REPOSITORY}/.github/workflows/publish-preview.yml@refs/heads/main` }),
      403,
    ],
    ['wrong repository_id', () => mint({ repository_id: '999999' }), 403],
    ['wrong repository_owner_id', () => mint({ repository_owner_id: '999999' }), 403],
    ['numeric repository_id (no coercion)', () => mint({ repository_id: 778899 }), 401],
    ['non-base64url characters', () => 'aa*a.bb!b.cc c', 401],
    ['oversized token', () => `${'a'.repeat(9000)}.bbbb.cccc`, 401],
  ]

  for (const [name, make, status] of cases) {
    it(`rejects ${name}`, async () => {
      const res = await post('/-/publish', publishBody(), await make())
      expect(res.status).toBe(status)
    })
  }

  // Status alone cannot tell "rejected for the right reason" from "rejected by
  // some earlier check", and every case above answers 401 or 403. These pin the
  // reason for the ones where a wrong-but-passing implementation is plausible:
  // an `alg: none` token rejected only because its signature fails would still
  // be a broken verifier if someone later made the signature check lenient.
  it('rejects alg: none on the algorithm, before any key lookup', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token =
      `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT', kid: KID }))}.` +
      `${b64url(JSON.stringify({ iss: GITHUB_OIDC_ISSUER, exp: now + 300 }))}.` +
      'AA'
    const res = await post('/-/publish', publishBody(), token)
    expect(await res.json()).toEqual({ error: 'Unsupported token algorithm' })
    expect(jwksFetches).toBe(0)
  })

  it('rejects an untrusted signing key on the signature, not the claims', async () => {
    const res = await post('/-/publish', publishBody(), await mintWithForeignKey())
    expect(await res.json()).toEqual({ error: 'Token signature is invalid' })
  })

  it('rejects a foreign repository on identity, not on workflow_ref', async () => {
    const res = await post('/-/publish', publishBody(), await mint({ repository_id: '424242' }))
    expect(await res.json()).toEqual({
      error: 'Token is not from the trusted repository',
    })
  })
})

/**
 * The parse bounds are unreachable over HTTP for segment counts other than
 * three: `looksLikeJwt` routes those to the admin-token path, so a test posting
 * `a.b` would 401 as a bad admin token and prove nothing about the verifier.
 * Call the verifier directly for those.
 */
describe('OIDC token parsing bounds (SR-3)', () => {
  const config = {
    audience: AUDIENCE,
    workflows: [TRUSTED_WORKFLOW],
    repositoryId: REPOSITORY_ID,
    ownerId: OWNER_ID,
  }
  // `env` from cloudflare:test is typed from the test wrangler config; the
  // verifier only touches KV on it.
  const reject = (token: string, expected: RegExp) =>
    expect(verifyOidcToken(env as unknown as Env, token, config)).rejects.toThrow(
      expected,
    )

  it('rejects a two-segment token', () => reject('aaaa.bbbb', /three segments/))
  it('rejects a four-segment token', () => reject('aa.bb.cc.dd', /three segments/))
  it('rejects an empty segment', () => reject('aa..cc', /three segments|empty segment/))
  it('rejects an oversized token', () =>
    reject(`${'a'.repeat(9000)}.bb.cc`, /too large/))
  it('rejects base64url padding', () => reject('aa=.bb.cc', /base64url/))
  it('rejects an oversized header segment', () =>
    reject(`${'a'.repeat(2000)}.bb.cc`, /header too large/))

  it('rejects an over-long kid before fetching keys', async () => {
    const token =
      `${b64url(JSON.stringify({ alg: 'RS256', kid: 'k'.repeat(500) }))}.bb.cc`
    await reject(token, /kid/)
    expect(jwksFetches).toBe(0)
  })

  it('rejects a segment whose bytes are not valid UTF-8', async () => {
    // Found in production: `aaa.bbb.ccc` returned 500, not 401. "aaa" is a
    // legal base64url segment, but it decodes to 0x69 0xa6, which is invalid
    // UTF-8, and TextDecoder({fatal}) throws a plain TypeError. The base64url
    // alphabet says nothing about UTF-8 validity, so this is reachable from
    // any well-formed-looking token.
    await reject('aaa.bbb.ccc', /not valid UTF-8/)
  })

  it('rejects a header that decodes to a non-object', async () => {
    await reject(`${b64url('"a string"')}.bb.cc`, /not an object/)
  })

  it('rejects a renamed repository that still matches workflow_ref', async () => {
    // Same numeric ids would pass; the point is that a DIFFERENT repository
    // reusing the trusted name does not, because the ids anchor the check.
    const res = await post(
      '/-/publish',
      publishBody(),
      await mint({ repository_id: '424242', repository_owner_id: '424242' }),
    )
    expect(res.status).toBe(403)
  })
})

describe('OIDC publishing: prUrl scoping (SR-2)', () => {
  it('rejects a prUrl pointing at another repository', async () => {
    const res = await post(
      '/-/register',
      { ref: `commit.${SHA}`, prUrl: 'https://github.com/attacker/repo/pull/1' },
      await mint(),
    )
    expect(res.status).toBe(403)
  })

  it('rejects a prUrl prefixed with the trusted repo but hosted elsewhere', async () => {
    const res = await post(
      '/-/register',
      {
        ref: `commit.${SHA}`,
        prUrl: `https://evil.example.com/${REPOSITORY}/pull/1`,
      },
      await mint(),
    )
    expect(res.status).toBe(403)
  })

  it('refuses to re-point an existing ref at a different PR', async () => {
    const ref = `commit.${'c'.repeat(40)}`
    const first = await post(
      '/-/register',
      { ref, prUrl: `https://github.com/${REPOSITORY}/pull/1` },
      await mint(),
    )
    expect(first.status).toBe(201)

    const second = await post(
      '/-/register',
      { ref, prUrl: `https://github.com/${REPOSITORY}/pull/2` },
      await mint(),
    )
    expect(second.status).toBe(400)
  })

  it('allows re-registering the same ref with the same PR', async () => {
    const ref = `commit.${'d'.repeat(40)}`
    const url = `https://github.com/${REPOSITORY}/pull/7`
    expect((await post('/-/register', { ref, prUrl: url }, await mint())).status).toBe(201)
    expect((await post('/-/register', { ref, prUrl: url }, await mint())).status).toBe(201)
  })

  it('allows one PR to accumulate a ref per pushed commit', async () => {
    // The pr-<n> dist-tag is meant to advance to a PR's head build, so this
    // must NOT be mistaken for the hijack case above.
    const url = `https://github.com/${REPOSITORY}/pull/9`
    for (const sha of ['1'.repeat(40), '2'.repeat(40)]) {
      const res = await post('/-/register', { ref: `commit.${sha}`, prUrl: url }, await mint())
      expect(res.status).toBe(201)
    }
    const refs = (await (await SELF.fetch(`${BASE}/-/refs`)).json()) as {
      refs: Array<{ ref: string; prUrl: string | null }>
    }
    expect(refs.refs.filter((r) => r.prUrl === url)).toHaveLength(2)
  })

  it('lets the admin token correct a bad registration', async () => {
    const ref = `commit.${'e'.repeat(40)}`
    await post('/-/register', { ref, prUrl: `https://github.com/${REPOSITORY}/pull/1` }, await mint())
    const fixed = await post(
      '/-/register',
      { ref, prUrl: `https://github.com/${REPOSITORY}/pull/2` },
      'test-admin-token',
    )
    expect(fixed.status).toBe(201)
  })
})

/**
 * The state right after this ships but before anyone sets the OIDC vars.
 * Consumers still publish with the admin token then, so it has to keep working;
 * it is also the configuration the staging smoke runs under.
 */
describe('OIDC publishing: config states', () => {
  const KEYS = [
    'OIDC_AUDIENCE',
    'OIDC_TRUSTED_WORKFLOWS',
    'OIDC_TRUSTED_REPOSITORY_ID',
    'OIDC_TRUSTED_OWNER_ID',
  ] as const
  const saved: Record<string, unknown> = {}
  const mutable = env as unknown as Record<string, unknown>

  const clearAll = (): void => {
    for (const key of KEYS) {
      saved[key] = mutable[key]
      delete mutable[key]
    }
  }
  const restore = (): void => {
    for (const key of KEYS) mutable[key] = saved[key]
  }

  it('keeps accepting the admin token when OIDC is entirely unconfigured', async () => {
    clearAll()
    try {
      expect((await post('/-/publish', publishBody(), 'test-admin-token')).status).toBe(201)
      expect(
        (await post('/-/register', { ref: `commit.${SHA}` }, 'test-admin-token')).status,
      ).toBe(201)
    } finally {
      restore()
    }
  })

  it('rejects a JWT as unauthorized, not 503, when OIDC is unconfigured', async () => {
    const token = await mint()
    clearAll()
    try {
      expect((await post('/-/publish', publishBody(), token)).status).toBe(401)
    } finally {
      restore()
    }
  })

  it('accepts an admin token that happens to be JWT-shaped', async () => {
    // Token shape must not decide which credential a value is. A three-segment
    // ADMIN_TOKEN routed into OIDC verification would fail every publish and
    // `pnpm warm` while still working on /-/purge, which compares it directly.
    const jwtShaped = 'aaaa.bbbb.cccc'
    const previous = mutable.ADMIN_TOKEN
    mutable.ADMIN_TOKEN = jwtShaped
    try {
      expect((await post('/-/publish', publishBody(), jwtShaped)).status).toBe(201)
      // And /-/purge, which never had the routing, still agrees.
      const purge = await post(
        '/-/purge',
        { package: 'vite-plus', version: VERSION },
        jwtShaped,
      )
      expect(purge.status).toBe(200)
    } finally {
      mutable.ADMIN_TOKEN = previous
    }
  })

  it('fails every publish loudly when OIDC is only half configured', async () => {
    // Deployment hazard: setting the audience but forgetting the repository id
    // takes the ADMIN path down too, because the config is resolved before the
    // credential is routed. A 503 naming the missing var beats rejecting every
    // token as 401 with no clue why.
    saved.OIDC_TRUSTED_REPOSITORY_ID = mutable.OIDC_TRUSTED_REPOSITORY_ID
    delete mutable.OIDC_TRUSTED_REPOSITORY_ID
    try {
      const res = await post('/-/publish', publishBody(), 'test-admin-token')
      expect(res.status).toBe(503)
      expect(((await res.json()) as { error: string }).error).toMatch(
        /OIDC_TRUSTED_REPOSITORY_ID/,
      )
    } finally {
      mutable.OIDC_TRUSTED_REPOSITORY_ID = saved.OIDC_TRUSTED_REPOSITORY_ID
    }
  })
})

describe('OIDC publishing: endpoint scoping', () => {
  it('does not accept an OIDC token for purge', async () => {
    const res = await post(
      '/-/purge',
      { package: 'vite-plus', version: VERSION },
      await mint(),
    )
    expect(res.status).toBe(401)
  })
})
