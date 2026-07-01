import { SELF } from 'cloudflare:test'
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { createTarGzip, parseTarGzip } from 'nanotar'

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

// Real npm only returns the per-version `time` map in the FULL packument
// (`Accept: application/json`), never in the abbreviated (install-v1) form.
const NPM_VITE_PLUS_TIME = {
  created: '2024-01-01T00:00:00.000Z',
  modified: '2026-06-18T05:33:32.399Z',
  '0.2.1': '2026-06-18T05:33:32.399Z',
}

// Counts fetches of the FULL (time-bearing) vite-plus packument, to verify the
// KV time-map cache prevents a per-request refetch.
let fullTimeFetches = 0
// Counts fetches of the ABBREVIATED vite-plus packument, to verify the KV
// packument cache prevents a per-request refetch.
let abbreviatedFetches = 0

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
  // The suite's fixture ref `commit.a832a55` (registered in beforeEach).
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

  const mockFetch = (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString()

    if (url === 'https://registry.npmjs.org/vite-plus') {
      // Mimic npm: `time` is present only in the full packument, not the
      // abbreviated (install-v1) form. Branch on the Accept header.
      const h = init?.headers
      const accept = (
        h instanceof Headers ? h.get('accept') : (h as Record<string, string>)?.accept
      ) ?? ''
      const abbreviated = accept.includes('install-v1')
      if (abbreviated) abbreviatedFetches++
      else fullTimeFetches++
      const body = abbreviated
        ? { ...NPM_VITE_PLUS, modified: NPM_VITE_PLUS_TIME.modified }
        : { ...NPM_VITE_PLUS, time: NPM_VITE_PLUS_TIME }
      return Promise.resolve(json(body))
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

// The suite's fixture preview ref (`commit.a832a55`), published before each test
// (idempotent, so it survives storage isolation). Publishing vite-plus + core
// with their rewritten package.json is exactly what a CI publish stores, so
// packuments inject the ref the way they do in production. (`POST /-/refs`
// register-only was removed; a ref exists only once it has been published.)
const FIXTURE_VERSION = '0.0.0-commit.a832a55'
beforeEach(async () => {
  await SELF.fetch(`${BASE}/-/publish`, {
    method: 'POST',
    headers: {
      authorization: 'Bearer test-admin-token',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'commit.a832a55',
      packages: [
        {
          name: 'vite-plus',
          version: FIXTURE_VERSION,
          packageJson: {
            name: 'vite-plus',
            version: FIXTURE_VERSION,
            dependencies: { '@voidzero-dev/vite-plus-core': FIXTURE_VERSION },
            optionalDependencies: {
              '@voidzero-dev/vite-plus-darwin-arm64': `0.0.0-commit.${PLATFORM_SHA}`,
            },
            bin: { vp: './bin/vp' },
          },
          integrity: 'sha512-Zm9vYmFy',
          shasum: 'a'.repeat(40),
        },
        {
          name: '@voidzero-dev/vite-plus-core',
          version: FIXTURE_VERSION,
          packageJson: {
            name: '@voidzero-dev/vite-plus-core',
            version: FIXTURE_VERSION,
            dependencies: { 'vite-plus': FIXTURE_VERSION },
          },
          integrity: 'sha512-Y29yZQ',
          shasum: 'b'.repeat(40),
        },
      ],
    }),
  })
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

    // preview version injected.
    const preview = body.versions['0.0.0-commit.a832a55']
    expect(preview).toBeTruthy()
    expect(preview.version).toBe('0.0.0-commit.a832a55')
    expect(preview.dependencies['@voidzero-dev/vite-plus-core']).toBe(
      '0.0.0-commit.a832a55',
    )
    expect(preview.dist.tarball).toBe(
      `${BASE}/tarballs/vite-plus/0.0.0-commit.a832a55.tgz`,
    )
    expect(res.headers.get('cache-control')).toContain('max-age=300')
  })

  it('includes a `time` field with npm publish times and the preview version', async () => {
    // Reproduces ERR_PNPM_MISSING_TIME: pnpm's time-based resolution (e.g.
    // `minimum-release-age`) needs `time`. npm only exposes it in the full
    // packument, and each injected preview version needs its own entry too.
    const res = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>

    expect(body.time).toBeTruthy()
    // npm's real publish time is preserved (requires sourcing the full packument).
    expect(body.time['0.2.1']).toBe('2026-06-18T05:33:32.399Z')
    // the injected preview version carries a time entry, or pnpm hard-errors.
    expect(body.time['0.0.0-commit.a832a55']).toBeTruthy()
  })

  it('serves npm time consistently across repeated requests (time-map cache)', async () => {
    // npm's `time` map is cached per-colo so the full packument isn't reparsed
    // every request; repeated requests must still serve the correct npm times,
    // and the per-request preview-time injection must not corrupt the cached map.
    const timeOf = async () =>
      (
        (await (
          await SELF.fetch(`${BASE}/vite-plus`, {
            headers: { accept: 'application/json' },
          })
        ).json()) as Record<string, any>
      ).time as Record<string, string>
    const a = await timeOf()
    const b = await timeOf()
    expect(a['0.2.1']).toBe('2026-06-18T05:33:32.399Z')
    expect(b['0.2.1']).toBe('2026-06-18T05:33:32.399Z')
    // the preview time is still injected on every request (not lost to caching).
    expect(b['0.0.0-commit.a832a55']).toBeTruthy()
  })

  it('caches the npm time map in KV (full packument fetched at most once)', async () => {
    const before = fullTimeFetches
    const get = () =>
      SELF.fetch(`${BASE}/vite-plus`, { headers: { accept: 'application/json' } })
    await get()
    await get()
    // With the KV cache the full (time-bearing) packument is fetched at most
    // once across the two requests; without it each request would refetch it.
    expect(fullTimeFetches - before).toBeLessThanOrEqual(1)
  })

  it('caches the abbreviated packument in KV (fetched at most once)', async () => {
    // The Void runtime does not edge-cache the assembled response, so without
    // this KV cache every fresh client would re-fetch the abbreviated packument
    // from npm. Two requests must hit npm for it at most once.
    const before = abbreviatedFetches
    const get = () =>
      SELF.fetch(`${BASE}/vite-plus`, { headers: { accept: 'application/json' } })
    await get()
    await get()
    expect(abbreviatedFetches - before).toBeLessThanOrEqual(1)
  })

  it('rebuilds a cached packument when a ref is published (output cache invalidates on etag)', async () => {
    // The assembled packument is cached keyed by the refs-index etag. Publishing
    // rewrites the index (new etag), so even a warm cache must rebuild on the next
    // request and surface the new version, never serve the stale body.
    const sha = 'f5f5f5f'
    const ver = `0.0.0-commit.${sha}`
    // Warm the output cache for vite-plus under the current etag.
    await SELF.fetch(`${BASE}/vite-plus`, { headers: { accept: 'application/json' } })
    const pub = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: `commit.${sha}`,
        packages: [
          {
            name: 'vite-plus',
            version: ver,
            packageJson: { name: 'vite-plus', version: ver },
            integrity: 'sha512-f5',
            shasum: 'f5',
          },
        ],
      }),
    })
    expect(pub.status).toBe(201)
    const res = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/json' },
    })
    const body = (await res.json()) as Record<string, any>
    expect(body.versions[ver]?.dist?.integrity).toBe('sha512-f5')
  })

  it('stamps the preview release date server-side at publish, stable across requests', async () => {
    // The release date is stamped server-side once at publish, not npm's
    // package-modified time, not a per-request clock, and not a client value.
    const sha = 'feedfacefeedfacefeedfacefeedfacefeedface'
    const ver = `0.0.0-commit.${sha}`
    const before = Date.now()
    const pub = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: `commit.${sha}`,
        // A client-reported time must be ignored in favor of the server's.
        publishedAt: '2000-01-01T00:00:00.000Z',
        packages: [
          {
            name: '@voidzero-dev/vite-plus-core',
            version: ver,
            packageJson: { name: '@voidzero-dev/vite-plus-core', version: ver },
            integrity: 'sha512-test',
            shasum: '',
          },
        ],
      }),
    })
    expect(pub.status).toBe(201)

    const timeFor = async () =>
      (
        (await (
          await SELF.fetch(`${BASE}/@voidzero-dev%2Fvite-plus-core`, {
            headers: { accept: 'application/json' },
          })
        ).json()) as Record<string, any>
      ).time?.[ver]

    const t1 = await timeFor()
    const t2 = await timeFor()
    expect(t1).toBeTruthy()
    expect(t1).toBe(t2) // stamped once at publish, identical across requests
    // server's time, not the bogus client value, and not the unpublished fallback
    expect(t1).not.toBe('2000-01-01T00:00:00.000Z')
    expect(Date.parse(t1)).toBeGreaterThanOrEqual(before)
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
    // A synthesized (not-on-npm) packument still needs `time` for the preview,
    // or pnpm errors with ERR_PNPM_MISSING_TIME.
    expect(body.time?.['0.0.0-commit.a832a55']).toBeTruthy()
  })

  it('surfaces an npm registry error (non-200, non-404) instead of synthesizing', async () => {
    // 404 means "not on npm" and is synthesized (above). Any other upstream
    // error must propagate npm's status, not hide behind a 200 packument that
    // silently drops the package's real versions. Use a workspace package the
    // suite never fetches, so the npm packument is a cold KV miss (a warm cache
    // would, by design, ride out the blip and serve the cached packument).
    const saved = globalThis.fetch
    vi.stubGlobal('fetch', () =>
      Promise.resolve(json({ error: 'upstream boom' }, 503)),
    )
    try {
      const res = await SELF.fetch(`${BASE}/@voidzero-dev%2Fvite-plus-uncached`, {
        headers: { accept: 'application/json' },
      })
      expect(res.status).toBe(503)
    } finally {
      vi.stubGlobal('fetch', saved)
    }
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
    // The fixture ref has no darwin meta published, so the platform packument
    // derives os/cpu from the package name (platformMetaFromName).
    const res = await SELF.fetch(
      `${BASE}/@voidzero-dev%2Fvite-plus-darwin-arm64`,
      { headers: { accept: 'application/json' } },
    )
    const body = (await res.json()) as Record<string, any>
    const v = body.versions[FIXTURE_VERSION]
    expect(v).toBeTruthy()
    expect(v.os).toEqual(['darwin'])
    expect(v.cpu).toEqual(['arm64'])
    expect(v.dist.tarball).toBe(
      `${BASE}/tarballs/@voidzero-dev/vite-plus-darwin-arm64/${FIXTURE_VERSION}.tgz`,
    )
  })

  it('redirects an un-uploaded platform binary to pkg.pr.new', async () => {
    // The Worker never builds platform binaries; until CI uploads one, the
    // tarball endpoint redirects to pkg.pr.new (which serves identical bytes).
    const res = await SELF.fetch(
      `${BASE}/tarballs/@voidzero-dev/vite-plus-darwin-arm64/0.0.0-commit.deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.tgz`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      'https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-darwin-arm64@deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
    )
  })

  it('serves an uploaded platform binary from R2 with a Content-Length', async () => {
    const ver = '0.0.0-commit.cafebabecafebabecafebabecafebabecafebabe'
    const pkg = '@voidzero-dev/vite-plus-darwin-arm64'
    const tarball = await makeTarball({ name: pkg, version: ver, os: ['darwin'], cpu: ['arm64'] })

    const up = await SELF.fetch(`${BASE}/-/tarball/${pkg}/${ver}.tgz`, {
      method: 'PUT',
      headers: AUTH,
      body: tarball,
    })
    expect(up.status).toBe(201)

    const res = await SELF.fetch(`${BASE}/tarballs/${pkg}/${ver}.tgz`)
    expect(res.status).toBe(200)
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect(res.headers.get('content-length')).toBe(String(bytes.byteLength))
    expect(bytes).toEqual(tarball)
  })

  it('rejects an unauthenticated upload', async () => {
    const res = await SELF.fetch(
      `${BASE}/-/tarball/@voidzero-dev/vite-plus-darwin-arm64/0.0.0-commit.${PLATFORM_SHA}.tgz`,
      { method: 'PUT', body: 'x' },
    )
    expect(res.status).toBe(401)
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

  it('advertises a CI-published platform binary integrity matching the served tarball', async () => {
    const ver = `0.0.0-commit.${PLATFORM_SHA}`
    const pkg = '@voidzero-dev/vite-plus-darwin-arm64'
    const tarball = await makeTarball({ name: pkg, version: ver, os: ['darwin'], cpu: ['arm64'] })
    const integrity = `sha512-${btoa(
      String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-512', tarball))),
    )}`

    // CI uploads the tarball, then publishes its meta + registers the ref.
    const up = await SELF.fetch(`${BASE}/-/tarball/${pkg}/${ver}.tgz`, {
      method: 'PUT',
      headers: AUTH,
      body: tarball,
    })
    expect(up.status).toBe(201)
    const pub = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: `commit.${PLATFORM_SHA}`,
        packages: [
          {
            name: pkg,
            version: ver,
            packageJson: { name: pkg, version: ver, os: ['darwin'], cpu: ['arm64'] },
            integrity,
            shasum: '',
          },
        ],
      }),
    })
    expect(pub.status).toBe(201)

    // The tarball serves from R2, and the packument advertises an integrity that
    // matches those exact served bytes.
    const tres = await SELF.fetch(`${BASE}/tarballs/${pkg}/${ver}.tgz`)
    expect(tres.status).toBe(200)
    const served = new Uint8Array(await tres.arrayBuffer())
    const servedIntegrity = `sha512-${btoa(
      String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-512', served))),
    )}`
    expect(servedIntegrity).toBe(integrity)

    const pres = await SELF.fetch(`${BASE}/@voidzero-dev%2Fvite-plus-darwin-arm64`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    const body = (await pres.json()) as Record<string, any>
    expect(body.versions[ver].dist.integrity).toBe(integrity)
  })
})

const AUTH = { authorization: 'Bearer test-admin-token' }

describe('pkg.pr.new-style download', () => {
  it('redirects /<owner>/<repo>@<sha> to the version tarball', async () => {
    const sha = 'abc1234'
    const res = await SELF.fetch(`${BASE}/voidzero-dev/vite-plus@${sha}`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${BASE}/tarballs/vite-plus/0.0.0-commit.${sha}.tgz`,
    )
    // The PR->version mapping is mutable, so the redirect is not cached.
    expect(res.headers.get('cache-control')).toBe('no-store')
    // pkg.pr.new-style commit key is on the redirect too.
    expect(res.headers.get('x-commit-key')).toBe(`voidzero-dev:vite-plus:${sha}`)
    expect(res.headers.get('x-pkg-name-key')).toBe('vite-plus')
  })

  it('redirects /<owner>/<repo>/<scoped-pkg>@<sha> to that package', async () => {
    const sha = 'def5678'
    const res = await SELF.fetch(
      `${BASE}/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-core@${sha}`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${BASE}/tarballs/@voidzero-dev/vite-plus-core/0.0.0-commit.${sha}.tgz`,
    )
  })

  it('redirects /<owner>/<repo>@<pr> to the PR latest commit tarball', async () => {
    const prUrl = 'https://github.com/voidzero-dev/vite-plus/pull/909'
    const publish = (sha: string, version: string) =>
      SELF.fetch(`${BASE}/-/publish`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          ref: `commit.${sha}`,
          prUrl,
          packages: [
            {
              name: 'vite-plus',
              version,
              packageJson: { name: 'vite-plus', version },
              integrity: 'sha512-test',
              shasum: '',
            },
          ],
        }),
      })
    const verB = '0.0.0-commit.ddd9090'
    expect((await publish('ccc9090', '0.0.0-commit.ccc9090')).status).toBe(201)
    await SELF.fetch(`${BASE}/-/refs`) // keep B's server-stamp strictly later
    expect((await publish('ddd9090', verB)).status).toBe(201)

    const res = await SELF.fetch(`${BASE}/voidzero-dev/vite-plus@909`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(
      `${BASE}/tarballs/vite-plus/${verB}.tgz`,
    )
  })

  it('404s for a PR with no published build', async () => {
    const res = await SELF.fetch(`${BASE}/voidzero-dev/vite-plus@999999`, {
      redirect: 'manual',
    })
    expect(res.status).toBe(404)
  })

  it('HEAD <owner>/<repo>@<sha> -> 200 with the commit key, no redirect', async () => {
    const sha = 'f0f0f0f'
    const res = await SELF.fetch(`${BASE}/voidzero-dev/vite-plus@${sha}`, {
      method: 'HEAD',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-commit-key')).toBe(`voidzero-dev:vite-plus:${sha}`)
    expect(res.headers.get('x-pkg-name-key')).toBe('vite-plus')
    // HEAD resolves the commit; it does not redirect to the tarball.
    expect(res.headers.get('location')).toBeNull()
  })

  it('HEAD <owner>/<repo>@<pr> -> 200 with the PR latest commit key', async () => {
    const prUrl = 'https://github.com/voidzero-dev/vite-plus/pull/808'
    const sha = 'e1e1e10'
    const version = `0.0.0-commit.${sha}`
    const pub = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: `commit.${sha}`,
        prUrl,
        packages: [
          {
            name: 'vite-plus',
            version,
            packageJson: { name: 'vite-plus', version },
            integrity: 'sha512-test',
            shasum: '',
          },
        ],
      }),
    })
    expect(pub.status).toBe(201)
    const res = await SELF.fetch(`${BASE}/voidzero-dev/vite-plus@808`, {
      method: 'HEAD',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('x-commit-key')).toBe(`voidzero-dev:vite-plus:${sha}`)
    expect(res.headers.get('x-pkg-name-key')).toBe('vite-plus')
  })
})

describe('CORS', () => {
  it('sets access-control-allow-origin: * on the packument', async () => {
    const res = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/json' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('sets the CORS header on /-/refs and the download redirect', async () => {
    const refs = await SELF.fetch(`${BASE}/-/refs`)
    expect(refs.headers.get('access-control-allow-origin')).toBe('*')
    const dl = await SELF.fetch(`${BASE}/voidzero-dev/vite-plus@abc1234`, {
      redirect: 'manual',
    })
    expect(dl.status).toBe(302)
    expect(dl.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('sets the CORS header on error responses', async () => {
    // Unknown package in the download path -> 404 via onError.
    const res = await SELF.fetch(
      `${BASE}/voidzero-dev/vite-plus/not-a-pkg@abc1234`,
      { redirect: 'manual' },
    )
    expect(res.status).toBe(404)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it('answers an OPTIONS preflight with the CORS header', async () => {
    const res = await SELF.fetch(`${BASE}/vite-plus`, { method: 'OPTIONS' })
    expect(res.status).toBeLessThan(300)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })
})

describe('admin: refs', () => {
  it('lists the registered refs without auth (public read)', async () => {
    const res = await SELF.fetch(`${BASE}/-/refs`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { refs: Array<{ ref: string }> }
    expect(body.refs.some((r) => r.ref === 'commit.a832a55')).toBe(true)
  })

  it('surfaces the server-stamped publish time and PR url for a published ref', async () => {
    const sha = 'deadbee'
    const version = `0.0.0-commit.${sha}`
    const prUrl = 'https://github.com/voidzero-dev/vite-plus/pull/123'
    const pub = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: `commit.${sha}`,
        prUrl,
        packages: [
          {
            name: 'vite-plus',
            version,
            packageJson: { name: 'vite-plus', version },
            integrity: 'sha512-test',
            shasum: '',
          },
        ],
      }),
    })
    expect(pub.status).toBe(201)

    const res = await SELF.fetch(`${BASE}/-/refs`)
    const body = (await res.json()) as {
      refs: Array<{
        ref: string
        version: string
        publishedAt: string | null
        prUrl: string | null
        expiresAt: string | null
      }>
    }
    const entry = body.refs.find((r) => r.ref === `commit.${sha}`)
    expect(entry).toBeTruthy()
    expect(entry!.version).toBe(version)
    // server-stamped at publish, a valid ISO timestamp.
    expect(typeof entry!.publishedAt).toBe('string')
    expect(Number.isNaN(Date.parse(entry!.publishedAt!))).toBe(false)
    expect(entry!.prUrl).toBe(prUrl)
    // expiresAt is an ISO TTL in the future (90 days out).
    expect(typeof entry!.expiresAt).toBe('string')
    expect(Date.parse(entry!.expiresAt!)).toBeGreaterThan(
      Date.parse(entry!.publishedAt!),
    )
    // the old dist-tag field is gone.
    expect(entry).not.toHaveProperty('tag')
  })

  it('omits the PR url for a ref published without one (push run)', async () => {
    const sha = 'beefca0'
    const version = `0.0.0-commit.${sha}`
    const pub = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: `commit.${sha}`,
        packages: [
          {
            name: 'vite-plus',
            version,
            packageJson: { name: 'vite-plus', version },
            integrity: 'sha512-test',
            shasum: '',
          },
        ],
      }),
    })
    expect(pub.status).toBe(201)

    const res = await SELF.fetch(`${BASE}/-/refs`)
    const body = (await res.json()) as {
      refs: Array<{
        ref: string
        publishedAt: string | null
        prUrl: string | null
        expiresAt: string | null
      }>
    }
    const entry = body.refs.find((r) => r.ref === `commit.${sha}`)
    expect(entry).toBeTruthy()
    expect(typeof entry!.publishedAt).toBe('string')
    expect(entry!.prUrl).toBeNull()
    expect(typeof entry!.expiresAt).toBe('string')
  })

  it('injects a mutable pr-<n> dist-tag pointing at the PR latest commit', async () => {
    const prUrl = 'https://github.com/voidzero-dev/vite-plus/pull/777'
    const publish = (sha: string, version: string) =>
      SELF.fetch(`${BASE}/-/publish`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          ref: `commit.${sha}`,
          prUrl,
          packages: [
            {
              name: 'vite-plus',
              version,
              packageJson: { name: 'vite-plus', version },
              integrity: 'sha512-test',
              shasum: '',
            },
          ],
        }),
      })
    const verA = '0.0.0-commit.aaa7770'
    const verB = '0.0.0-commit.bbb7770'
    expect((await publish('aaa7770', verA)).status).toBe(201)
    // A read between publishes keeps B's server-stamp strictly later than A's.
    await SELF.fetch(`${BASE}/-/refs`)
    expect((await publish('bbb7770', verB)).status).toBe(201)

    const pack = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/json' },
    })
    const body = (await pack.json()) as Record<string, any>
    // both immutable commit versions are present...
    expect(body.versions[verA]).toBeTruthy()
    expect(body.versions[verB]).toBeTruthy()
    // ...and the PR tag points at the latest-published one (B).
    expect(body['dist-tags']['pr-777']).toBe(verB)
  })

  it('rejects an invalid ref (publish)', async () => {
    const res = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({
        ref: 'nonsense',
        packages: [
          {
            name: 'vite-plus',
            version: '0.0.0-commit.abc1234',
            packageJson: { name: 'vite-plus', version: '0.0.0-commit.abc1234' },
            integrity: 'sha512-x',
            shasum: 'x',
          },
        ],
      }),
    })
    expect(res.status).toBe(400)
  })

  it('publishes concurrently without overwriting (incremental)', async () => {
    const publish = (sha: string) =>
      SELF.fetch(`${BASE}/-/publish`, {
        method: 'POST',
        headers: { ...AUTH, 'content-type': 'application/json' },
        body: JSON.stringify({
          ref: `commit.${sha}`,
          packages: [
            {
              name: 'vite-plus',
              version: `0.0.0-commit.${sha}`,
              packageJson: { name: 'vite-plus', version: `0.0.0-commit.${sha}` },
              integrity: 'sha512-x',
              shasum: 'x',
            },
          ],
        }),
      })
    // Two PRs publishing at the same time: both refs must survive the CAS.
    await Promise.all([publish('aaaaaaa'), publish('bbbbbbb')])
    const list = (await (
      await SELF.fetch(`${BASE}/-/refs`)
    ).json()) as { refs: Array<{ ref: string }> }
    const refs = list.refs.map((r) => r.ref)
    expect(refs).toContain('commit.aaaaaaa')
    expect(refs).toContain('commit.bbbbbbb')
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

describe('admin: publish', () => {
  const ver = '0.0.0-commit.f00dface'
  const body = {
    ref: 'commit.f00dface',
    packages: [
      { name: 'vite-plus', version: ver, packageJson: { name: 'vite-plus', version: ver }, integrity: 'sha512-abc', shasum: 'def' },
    ],
  }

  it('requires auth', async () => {
    const res = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(401)
  })

  it('stores meta, registers the ref, and injects it into the packument', async () => {
    const res = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({ ref: 'commit.f00dface', version: ver })

    const pack = await SELF.fetch(`${BASE}/vite-plus`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    const packument = (await pack.json()) as Record<string, any>
    expect(packument.versions[ver].dist.integrity).toBe('sha512-abc')
    expect(packument.versions[ver].dist.shasum).toBe('def')
  })

  it('rejects an unknown package', async () => {
    const res = await SELF.fetch(`${BASE}/-/publish`, {
      method: 'POST',
      headers: { ...AUTH, 'content-type': 'application/json' },
      body: JSON.stringify({ ref: 'commit.f00dface', packages: [{ name: 'react', version: ver }] }),
    })
    expect(res.status).toBe(400)
  })
})

describe('health', () => {
  it('responds ok', async () => {
    const res = await SELF.fetch(`${BASE}/_health`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'ok' })
  })
})
