import { SELF, env } from 'cloudflare:test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTarGzip, parseTarGzip } from 'nanotar'
import worker from '../src/index'

const BASE = 'https://bridge.example.com'

function makeTarball(pkg: Record<string, any>): Promise<Uint8Array> {
  return createTarGzip([
    { name: 'package/package.json', data: JSON.stringify(pkg) },
    { name: 'package/index.js', data: 'export const x = 1\n' },
  ])
}

const NPM_VITE_PLUS = {
  name: 'vite-plus',
  'dist-tags': { latest: '0.2.1' },
  versions: {
    '0.2.1': {
      name: 'vite-plus',
      version: '0.2.1',
      dist: {
        tarball: 'https://registry.npmjs.org/vite-plus/-/vite-plus-0.2.1.tgz',
      },
    },
  },
}

function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function gzip(bytes: Uint8Array): Response {
  return new Response(bytes, {
    headers: { 'content-type': 'application/gzip' },
  })
}

/**
 * The worker-under-test (reached via SELF.fetch) runs in this same isolate, so
 * a `vi.stubGlobal('fetch', ...)` mock intercepts its outbound calls to npm and
 * pkg.pr.new, while SELF.fetch (a service binding) still routes normally.
 */
const PLATFORM_SHA = '1234567890abcdef1234567890abcdef12345678'

beforeAll(async () => {
  const darwinBin = await makeTarball({
    name: '@voidzero-dev/vite-plus-darwin-arm64',
    version: '0.2.1',
    os: ['darwin'],
    cpu: ['arm64'],
  })
  // The configured ref is `commit.a832a55` (see vitest.config.ts).
  const vitePlusCommit = await makeTarball({
    name: 'vite-plus',
    version: 'a832a55',
    dependencies: { '@voidzero-dev/vite-plus-core': 'a832a55' },
    optionalDependencies: {
      '@voidzero-dev/vite-plus-darwin-arm64': `https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-darwin-arm64@${PLATFORM_SHA}`,
    },
    bin: { vp: './bin/vp' },
  })
  const coreCommit = await makeTarball({
    name: '@voidzero-dev/vite-plus-core',
    version: 'a832a55',
    dependencies: { 'vite-plus': 'a832a55' },
  })

  const mockFetch = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()

    if (url === 'https://registry.npmjs.org/vite-plus') {
      return Promise.resolve(json(NPM_VITE_PLUS))
    }
    if (url.startsWith('https://registry.npmjs.org/@voidzero-dev')) {
      return Promise.resolve(json({ error: 'Not found' }, 404))
    }
    if (url === 'https://registry.npmjs.org/react') {
      return Promise.resolve(json({ name: 'react', 'dist-tags': { latest: '19.0.0' } }))
    }
    if (url.endsWith('/vite-plus@a832a55')) {
      return Promise.resolve(gzip(vitePlusCommit))
    }
    if (url.endsWith('/@voidzero-dev/vite-plus-core@a832a55')) {
      return Promise.resolve(gzip(coreCommit))
    }
    if (url.endsWith(`/@voidzero-dev/vite-plus-darwin-arm64@${PLATFORM_SHA}`)) {
      return Promise.resolve(gzip(darwinBin))
    }
    return Promise.reject(new Error(`unexpected fetch: ${url}`))
  }

  vi.stubGlobal('fetch', mockFetch)
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('packument endpoint', () => {
  it('injects preview version into an existing npm packument', async () => {
    const res = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>

    // npm versions and latest are preserved.
    expect(body.versions['0.2.1']).toBeTruthy()
    expect(body['dist-tags'].latest).toBe('0.2.1')

    // preview version + dist-tag injected.
    const preview = body.versions['0.0.0-commit.a832a55']
    expect(preview).toBeTruthy()
    expect(preview.version).toBe('0.0.0-commit.a832a55')
    expect(preview.dependencies['@voidzero-dev/vite-plus-core']).toBe(
      '0.0.0-commit.a832a55',
    )
    expect(preview.dist.tarball).toBe(
      `${BASE}/tarballs/vite-plus/0.0.0-commit.a832a55.tgz`,
    )
    expect(body['dist-tags']['commit-a832a55']).toBe('0.0.0-commit.a832a55')
    expect(res.headers.get('cache-control')).toContain('max-age=300')
  })

  it('synthesizes a preview-only packument when npm has no such package', async () => {
    const res = await SELF.fetch(`${BASE}/@voidzero-dev%2Fvite-plus-core`, {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>

    expect(body.name).toBe('@voidzero-dev/vite-plus-core')
    expect(body['dist-tags'].latest).toBeUndefined()
    const preview = body.versions['0.0.0-commit.a832a55']
    expect(preview).toBeTruthy()
    expect(preview.dependencies['vite-plus']).toBe('0.0.0-commit.a832a55')
    expect(preview.dist.tarball).toBe(
      `${BASE}/tarballs/@voidzero-dev/vite-plus-core/0.0.0-commit.a832a55.tgz`,
    )
  })

  it('rewrites pkg.pr.new optionalDependency URLs to version strings', async () => {
    const res = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/json' },
    })
    const body = (await res.json()) as Record<string, any>
    const opt = body.versions['0.0.0-commit.a832a55'].optionalDependencies
    expect(opt['@voidzero-dev/vite-plus-darwin-arm64']).toBe(
      `0.0.0-commit.${PLATFORM_SHA}`,
    )
  })

  it('injects the version into a platform package packument with os/cpu', async () => {
    // Register the platform commit ref so the platform packument exposes it.
    await SELF.fetch(`${BASE}/-/refs`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer test-admin-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ref: `commit.${PLATFORM_SHA}` }),
    })
    const res = await SELF.fetch(
      `${BASE}/@voidzero-dev%2Fvite-plus-darwin-arm64`,
      { headers: { accept: 'application/json' } },
    )
    const body = (await res.json()) as Record<string, any>
    const v = body.versions[`0.0.0-commit.${PLATFORM_SHA}`]
    expect(v).toBeTruthy()
    expect(v.os).toEqual(['darwin'])
    expect(v.cpu).toEqual(['arm64'])
    expect(v.dist.tarball).toBe(
      `${BASE}/tarballs/@voidzero-dev/vite-plus-darwin-arm64/0.0.0-commit.${PLATFORM_SHA}.tgz`,
    )
  })

  it('serves a platform-binary tarball rewritten to the synthetic version', async () => {
    const res = await SELF.fetch(
      `${BASE}/tarballs/@voidzero-dev/vite-plus-darwin-arm64/0.0.0-commit.${PLATFORM_SHA}.tgz`,
    )
    expect(res.status).toBe(200)
    // Served from R2 with a Content-Length so a truncated transfer is
    // detectable (a streamed transform response was silently truncated, which
    // surfaced to clients as a gunzip "unexpected end of file").
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength))

    const files = await parseTarGzip(bytes)
    const pkg = JSON.parse(
      new TextDecoder().decode(
        files.find((f) => f.name === 'package/package.json')!.data,
      ),
    )
    expect(pkg.name).toBe('@voidzero-dev/vite-plus-darwin-arm64')
    expect(pkg.version).toBe(`0.0.0-commit.${PLATFORM_SHA}`)
    expect(pkg.os).toEqual(['darwin']) // platform fields preserved
    expect(pkg.cpu).toEqual(['arm64'])

    // Second fetch is served from the R2 cache (built once).
    const again = await SELF.fetch(
      `${BASE}/tarballs/@voidzero-dev/vite-plus-darwin-arm64/0.0.0-commit.${PLATFORM_SHA}.tgz`,
    )
    expect(again.status).toBe(200)
    expect(again.headers.get('content-length')).toBe(String(bytes.byteLength))
  })

  it('redirects non-allowlisted packages to npm', async () => {
    const res = await SELF.fetch(`${BASE}/react`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://registry.npmjs.org/react',
    )
  })
})

describe('tarball endpoint', () => {
  it('serves a generated commit tarball with rewritten package.json and immutable cache', async () => {
    const res = await SELF.fetch(`${BASE}/tarballs/vite-plus/0.0.0-commit.a832a55.tgz`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/gzip')
    expect(res.headers.get('cache-control')).toContain('immutable')

    const bytes = new Uint8Array(await res.arrayBuffer())
    const files = await parseTarGzip(bytes)
    const pkgFile = files.find((f) => f.name === 'package/package.json')
    const pkg = JSON.parse(new TextDecoder().decode(pkgFile!.data))
    expect(pkg.name).toBe('vite-plus')
    expect(pkg.version).toBe('0.0.0-commit.a832a55')
    expect(pkg.dependencies['@voidzero-dev/vite-plus-core']).toBe(
      '0.0.0-commit.a832a55',
    )
  })

  it('also serves the npm-convention tarball path (/<name>/-/<name>-<version>.tgz)', async () => {
    const res = await SELF.fetch(
      `${BASE}/vite-plus/-/vite-plus-0.0.0-commit.a832a55.tgz`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/gzip')

    const bytes = new Uint8Array(await res.arrayBuffer())
    const files = await parseTarGzip(bytes)
    const pkgFile = files.find((f) => f.name === 'package/package.json')
    const pkg = JSON.parse(new TextDecoder().decode(pkgFile!.data))
    expect(pkg.name).toBe('vite-plus')
    expect(pkg.version).toBe('0.0.0-commit.a832a55')
  })

  it('serves the npm-convention path for a scoped preview package', async () => {
    const res = await SELF.fetch(
      `${BASE}/@voidzero-dev/vite-plus-core/-/vite-plus-core-0.0.0-commit.a832a55.tgz`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/gzip')
  })

  it('redirects an npm-convention path to npm for non-preview packages/versions', async () => {
    // Non-preview package: still proxied to npm.
    const other = await SELF.fetch(`${BASE}/react/-/react-18.2.0.tgz`, {
      redirect: 'manual',
    })
    expect(other.status).toBe(302)
    expect(other.headers.get('location')).toBe(
      'https://registry.npmjs.org/react/-/react-18.2.0.tgz',
    )
    // Preview package but a non-preview (real) version: proxied to npm too.
    const realVersion = await SELF.fetch(
      `${BASE}/vite-plus/-/vite-plus-0.2.1.tgz`,
      { redirect: 'manual' },
    )
    expect(realVersion.status).toBe(302)
  })

  it('rejects unknown preview packages', async () => {
    const res = await SELF.fetch(`${BASE}/tarballs/react/0.0.0-commit.a832a55.tgz`)
    expect(res.status).toBe(404)
  })

  it('rejects pr-number and other invalid preview versions', async () => {
    // PR-number versions are not supported (mutable refs).
    expect(
      (await SELF.fetch(`${BASE}/tarballs/vite-plus/0.0.0-pr.1891.tgz`)).status,
    ).toBe(400)
    expect(
      (await SELF.fetch(`${BASE}/tarballs/vite-plus/0.2.1.tgz`)).status,
    ).toBe(400)
  })
})

describe('integrity', () => {
  it('advertises computed integrity/shasum in the injected version', async () => {
    const res = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/json' },
    })
    const body = (await res.json()) as Record<string, any>
    const dist = body.versions['0.0.0-commit.a832a55'].dist
    expect(dist.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/)
    expect(dist.shasum).toMatch(/^[0-9a-f]{40}$/)
  })

  it('advertises a platform binary integrity matching the served tarball', async () => {
    const ver = `0.0.0-commit.${PLATFORM_SHA}`
    const pkg = '@voidzero-dev/vite-plus-darwin-arm64'

    // A prebuild task builds the tarball, then backfills integrity over the
    // finished R2 object (a separate pass from the build). Drive that path.
    await worker.queue!(
      {
        queue: 'pkg-pr-registry-bridge-prebuild',
        messages: [
          {
            id: '1',
            timestamp: new Date(0),
            attempts: 1,
            body: { version: ver, name: pkg },
            ack: () => {},
            retry: () => {},
          },
        ],
      } as any,
      env as any,
    )

    const tres = await SELF.fetch(`${BASE}/tarballs/${pkg}/${ver}.tgz`)
    expect(tres.status).toBe(200)
    const tarball = new Uint8Array(await tres.arrayBuffer())
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-512', tarball))
    const expected = `sha512-${btoa(String.fromCharCode(...digest))}`

    // Register the ref so the packument injects this version, then read it.
    await SELF.fetch(`${BASE}/-/refs`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: `commit.${PLATFORM_SHA}` }),
    })
    const pres = await SELF.fetch(`${BASE}/@voidzero-dev%2Fvite-plus-darwin-arm64`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    const body = (await pres.json()) as Record<string, any>
    expect(body.versions[ver].dist.integrity).toBe(expected)
  })
})

const AUTH = { authorization: 'Bearer test-admin-token' }

describe('admin: refs', () => {
  it('writes require auth (reads do not)', async () => {
    // POST/DELETE require the bearer token.
    expect(
      (await SELF.fetch(`${BASE}/-/refs`, { method: 'POST' })).status,
    ).toBe(401)
    expect(
      (await SELF.fetch(`${BASE}/-/refs`, {
        method: 'POST',
        headers: { authorization: 'Bearer wrong' },
      })).status,
    ).toBe(401)
  })

  it('lists the env-configured refs without auth (public read)', async () => {
    const res = await SELF.fetch(`${BASE}/-/refs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { refs: Array<{ ref: string }> }
    expect(body.refs.some((r) => r.ref === 'commit.a832a55')).toBe(true)
  })

  it('registers a ref in KV and injects it into the packument', async () => {
    const add = await SELF.fetch(`${BASE}/-/refs`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'commit.a832a55' }),
    })
    expect(add.status).toBe(201)
    expect((await add.json()) as any).toMatchObject({
      version: '0.0.0-commit.a832a55',
    })

    // The dynamically registered ref now appears in the packument.
    const pack = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/json' },
    })
    const body = (await pack.json()) as Record<string, any>
    expect(body.versions['0.0.0-commit.a832a55']).toBeTruthy()
    expect(body['dist-tags']['commit-a832a55']).toBe('0.0.0-commit.a832a55')
  })

  it('rejects an invalid ref', async () => {
    const res = await SELF.fetch(`${BASE}/-/refs`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'nonsense' }),
    })
    expect(res.status).toBe(400)
  })

  it('registers concurrently without overwriting (incremental)', async () => {
    const a = 'commit.aaaaaaa'
    const b = 'commit.bbbbbbb'
    const post = (ref: string) =>
      SELF.fetch(`${BASE}/-/refs`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({ ref }),
      })
    // Two PRs registering at the same time: both must survive.
    await Promise.all([post(a), post(b)])
    const list = (await (
      await SELF.fetch(`${BASE}/-/refs`, { headers: AUTH })
    ).json()) as { refs: Array<{ ref: string }> }
    const refs = list.refs.map((r) => r.ref)
    expect(refs).toContain(a)
    expect(refs).toContain(b)
  })

  it('unregisters a ref', async () => {
    // Use a sha that is not the env-configured ref, so removal is observable.
    const ref = 'commit.beefcafe'
    await SELF.fetch(`${BASE}/-/refs`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ref }),
    })
    const del = await SELF.fetch(`${BASE}/-/refs`, {
      method: 'DELETE',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ref }),
    })
    expect(del.status).toBe(200)
    const list = (await (
      await SELF.fetch(`${BASE}/-/refs`, { headers: AUTH })
    ).json()) as { refs: Array<{ ref: string }> }
    expect(list.refs.some((r) => r.ref === ref)).toBe(false)
  })
})

describe('admin: purge', () => {
  it('requires auth', async () => {
    const res = await SELF.fetch(`${BASE}/-/purge`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('validates package and version', async () => {
    const res = await SELF.fetch(`${BASE}/-/purge`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ package: 'react', version: '0.0.0-commit.a832a55' }),
    })
    expect(res.status).toBe(400)
  })

  it('purges an allowlisted preview build', async () => {
    const res = await SELF.fetch(`${BASE}/-/purge`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ package: 'vite-plus', version: '0.0.0-commit.a832a55' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toMatchObject({
      purged: { package: 'vite-plus', version: '0.0.0-commit.a832a55' },
    })
  })
})

describe('admin: prebuild', () => {
  it('requires auth', async () => {
    const res = await SELF.fetch(`${BASE}/-/prebuild`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'commit.a832a55' }),
    })
    expect(res.status).toBe(401)
  })

  it('enqueues a prebuild for a ref', async () => {
    const res = await SELF.fetch(`${BASE}/-/prebuild`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'commit.a832a55' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ queued: '0.0.0-commit.a832a55' })
  })

  it('rejects a non-preview version', async () => {
    const res = await SELF.fetch(`${BASE}/-/prebuild`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ version: '0.2.1' }),
    })
    expect(res.status).toBe(400)
  })
})

async function sign(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  const hex = [...new Uint8Array(mac)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  return `sha256=${hex}`
}

describe('admin: webhook', () => {
  const SECRET = 'test-webhook-secret'

  it('rejects an invalid signature', async () => {
    const res = await SELF.fetch(`${BASE}/-/webhook`, {
      method: 'POST',
      headers: {
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': 'sha256=deadbeef',
      },
      body: '{}',
    })
    expect(res.status).toBe(401)
  })

  it('auto-registers refs from a pkg.pr.new bot comment', async () => {
    const sha = '1234567890abcdef1234567890abcdef12345678'
    const body = JSON.stringify({
      action: 'created',
      issue: { number: 1891, pull_request: { url: 'x' } },
      comment: {
        user: { login: 'pkg-pr-new[bot]' },
        body: `vite-plus@1891 darwin-arm64@${sha}`,
      },
    })
    const res = await SELF.fetch(`${BASE}/-/webhook`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': await sign(SECRET, body),
      },
      body,
    })
    expect(res.status).toBe(200)
    const out = (await res.json()) as { registered: string[] }
    // Only the commit sha is registered (the PR number is not a supported ref).
    expect(out.registered).toEqual([`0.0.0-commit.${sha}`])

    const list = (await (
      await SELF.fetch(`${BASE}/-/refs`, {
        headers: { authorization: 'Bearer test-admin-token' },
      })
    ).json()) as { refs: Array<{ ref: string }> }
    expect(list.refs.some((r) => r.ref === `commit.${sha}`)).toBe(true)
  })

  it('ignores non-bot events and answers ping', async () => {
    const body = '{"zen":"hi"}'
    const res = await SELF.fetch(`${BASE}/-/webhook`, {
      method: 'POST',
      headers: {
        'x-github-event': 'ping',
        'x-hub-signature-256': await sign(SECRET, body),
      },
      body,
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toEqual({ ok: true })
  })
})

describe('prebuild queue consumer', () => {
  function message(body: Record<string, unknown>, sink: { acked: boolean }) {
    return {
      queue: 'pkg-pr-registry-bridge-prebuild',
      messages: [
        {
          id: '1',
          timestamp: new Date(0),
          attempts: 1,
          body,
          ack: () => {
            sink.acked = true
          },
          retry: () => {},
        },
      ],
    }
  }

  it('builds a single platform binary into R2 and acks', async () => {
    const ver = `0.0.0-commit.${PLATFORM_SHA}`
    const pkg = '@voidzero-dev/vite-plus-darwin-arm64'
    const sink = { acked: false }

    // A binary task: one bounded build, the unit the version task fans out to.
    await worker.queue!(message({ version: ver, name: pkg }, sink) as any, env as any)

    expect(sink.acked).toBe(true)
    const res = await SELF.fetch(`${BASE}/tarballs/${pkg}/${ver}.tgz`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe(
      String((await res.arrayBuffer()).byteLength),
    )
  })

  it('acks a version task (fan-out)', async () => {
    const sink = { acked: false }
    await worker.queue!(
      message({ version: '0.0.0-commit.a832a55' }, sink) as any,
      env as any,
    )
    expect(sink.acked).toBe(true)
  })
})

describe('health', () => {
  it('responds ok', async () => {
    const res = await SELF.fetch(`${BASE}/_health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
