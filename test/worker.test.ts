import { SELF } from 'cloudflare:test'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
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
beforeAll(async () => {
  const vitePlusPr = await makeTarball({
    name: 'vite-plus',
    version: '1891',
    dependencies: { '@voidzero-dev/vite-plus-core': '1891' },
    bin: { vp: './bin/vp' },
  })
  const corePr = await makeTarball({
    name: '@voidzero-dev/vite-plus-core',
    version: '1891',
    dependencies: { 'vite-plus': '1891' },
  })
  const vitePlusCommit = await makeTarball({
    name: 'vite-plus',
    version: 'a832a55',
    dependencies: { '@voidzero-dev/vite-plus-core': 'a832a55' },
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
    if (url.endsWith('/vite-plus@1891')) return Promise.resolve(gzip(vitePlusPr))
    if (url.endsWith('/@voidzero-dev/vite-plus-core@1891')) {
      return Promise.resolve(gzip(corePr))
    }
    if (url.endsWith('/vite-plus@a832a55')) {
      return Promise.resolve(gzip(vitePlusCommit))
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
    const preview = body.versions['0.0.0-pr.1891']
    expect(preview).toBeTruthy()
    expect(preview.version).toBe('0.0.0-pr.1891')
    expect(preview.dependencies['@voidzero-dev/vite-plus-core']).toBe(
      '0.0.0-pr.1891',
    )
    expect(preview.dist.tarball).toBe(
      `${BASE}/tarballs/vite-plus/0.0.0-pr.1891.tgz`,
    )
    expect(body['dist-tags']['pr-1891']).toBe('0.0.0-pr.1891')
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
    const preview = body.versions['0.0.0-pr.1891']
    expect(preview).toBeTruthy()
    expect(preview.dependencies['vite-plus']).toBe('0.0.0-pr.1891')
    expect(preview.dist.tarball).toBe(
      `${BASE}/tarballs/@voidzero-dev/vite-plus-core/0.0.0-pr.1891.tgz`,
    )
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
  it('serves a generated PR tarball with rewritten package.json', async () => {
    const res = await SELF.fetch(`${BASE}/tarballs/vite-plus/0.0.0-pr.1891.tgz`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/gzip')
    expect(res.headers.get('cache-control')).toContain('max-age=300')

    const bytes = new Uint8Array(await res.arrayBuffer())
    const files = await parseTarGzip(bytes)
    const pkgFile = files.find((f) => f.name === 'package/package.json')
    const pkg = JSON.parse(new TextDecoder().decode(pkgFile!.data))
    expect(pkg.name).toBe('vite-plus')
    expect(pkg.version).toBe('0.0.0-pr.1891')
    expect(pkg.dependencies['@voidzero-dev/vite-plus-core']).toBe(
      '0.0.0-pr.1891',
    )
  })

  it('serves commit tarballs with an immutable cache policy', async () => {
    const res = await SELF.fetch(
      `${BASE}/tarballs/vite-plus/0.0.0-commit.a832a55.tgz`,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toContain('immutable')

    const files = await parseTarGzip(new Uint8Array(await res.arrayBuffer()))
    const pkgFile = files.find((f) => f.name === 'package/package.json')
    const pkg = JSON.parse(new TextDecoder().decode(pkgFile!.data))
    expect(pkg.version).toBe('0.0.0-commit.a832a55')
  })

  it('rejects unknown preview packages', async () => {
    const res = await SELF.fetch(`${BASE}/tarballs/react/0.0.0-pr.1891.tgz`)
    expect(res.status).toBe(404)
  })

  it('rejects invalid preview versions', async () => {
    const res = await SELF.fetch(`${BASE}/tarballs/vite-plus/0.2.1.tgz`)
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
