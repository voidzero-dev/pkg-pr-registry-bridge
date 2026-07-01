import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isPreviewVersion,
  parsePreviewVersion,
} from '../src/preview/parsePreviewVersion'
import {
  parseConfiguredPreviewRefs,
  prNumberFromUrl,
} from '../src/preview/parseConfiguredPreviewRefs'
import { toPkgPrNewUrl } from '../src/preview/toPkgPrNewUrl'
import {
  encodeNpmPackageName,
  parseNpmTarballPath,
  parsePackagePath,
  parseTarballPath,
} from '../src/registry/parsePackageName'
import {
  rewritePackageJson,
  pkgPrNewUrlToVersion,
} from '../src/tarball/rewritePackageJson'
import { isWorkspacePackage } from '../src/preview/packages'
import {
  assertSafeTarballPath,
  isUnderPackageRoot,
} from '../src/security/validateTarballPath'
import { buildVersionMetadata } from '../src/registry/buildVersionMetadata'
import { computeDigests } from '../src/tarball/digests'
import { fetchUpstreamTarball } from '../src/tarball/fetchUpstreamTarball'
import { HttpError } from '../src/httpError'
import type { Env } from '../src/config'

const env = {
  PKG_PR_NEW_BASE: 'https://pkg.pr.new',
  PREVIEW_OWNER: 'voidzero-dev',
  PREVIEW_REPO: 'vite-plus',
  PUBLIC_BASE_URL: 'https://bridge.example.com',
  WORKSPACE_PACKAGES: 'vite-plus,@voidzero-dev/vite-plus-*',
} as Env

describe('parsePreviewVersion', () => {
  it('parses commit versions (short and long sha)', () => {
    expect(parsePreviewVersion('0.0.0-commit.a832a55')).toEqual({
      type: 'commit',
      ref: 'a832a55',
    })
    // Full 40-char SHA-1.
    expect(
      parsePreviewVersion(
        '0.0.0-commit.0123456789abcdef0123456789abcdef01234567',
      ),
    ).toEqual({
      type: 'commit',
      ref: '0123456789abcdef0123456789abcdef01234567',
    })
  })

  it('rejects pr-number versions and other malformed versions', () => {
    for (const v of [
      '0.2.1',
      'latest',
      '1891',
      'pr-1891',
      '0.0.0-pr.1891', // PR refs are not supported (mutable)
      '0.0.0-pr.1',
      '0.2.1-pr.1891',
      '0.0.0-commit.xyz',
      '0.0.0-commit.abc', // < 7 hex chars
    ]) {
      expect(parsePreviewVersion(v), v).toBeNull()
    }
    expect(isPreviewVersion('0.0.0-commit.a832a55')).toBe(true)
    expect(isPreviewVersion('0.2.1')).toBe(false)
  })
})

describe('parseConfiguredPreviewRefs', () => {
  it('parses commit refs into versions', () => {
    expect(parseConfiguredPreviewRefs('commit.a832a55')).toEqual([
      {
        type: 'commit',
        ref: 'a832a55',
        version: '0.0.0-commit.a832a55',
      },
    ])
  })

  it('returns [] for empty input', () => {
    expect(parseConfiguredPreviewRefs('')).toEqual([])
    expect(parseConfiguredPreviewRefs(undefined)).toEqual([])
  })

  it('rejects pr/invalid refs (strict throws)', () => {
    expect(() => parseConfiguredPreviewRefs('bogus')).toThrow()
    expect(() => parseConfiguredPreviewRefs('pr.1891')).toThrow()
  })
})

describe('prNumberFromUrl', () => {
  it('extracts the PR number from a GitHub PR url', () => {
    expect(
      prNumberFromUrl('https://github.com/voidzero-dev/vite-plus/pull/1569'),
    ).toBe('1569')
    // trailing path segments (e.g. /files) are tolerated.
    expect(prNumberFromUrl('https://github.com/o/r/pull/42/files')).toBe('42')
  })

  it('returns undefined for non-PR or missing urls', () => {
    expect(prNumberFromUrl(undefined)).toBeUndefined()
    expect(prNumberFromUrl('')).toBeUndefined()
    expect(prNumberFromUrl('https://github.com/o/r/commit/abc123')).toBeUndefined()
  })
})

describe('toPkgPrNewUrl', () => {
  it('maps scoped and unscoped commit names', () => {
    expect(
      toPkgPrNewUrl(env, '@voidzero-dev/vite-plus-core', '0.0.0-commit.a832a55'),
    ).toBe(
      'https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-core@a832a55',
    )
    expect(toPkgPrNewUrl(env, 'vite-plus', '0.0.0-commit.a832a55')).toBe(
      'https://pkg.pr.new/voidzero-dev/vite-plus/vite-plus@a832a55',
    )
    // PR-number versions are not preview versions -> null.
    expect(toPkgPrNewUrl(env, 'vite-plus', '0.0.0-pr.1891')).toBeNull()
  })

  it('returns null for non-preview versions', () => {
    expect(toPkgPrNewUrl(env, 'vite-plus', '0.2.1')).toBeNull()
  })
})

describe('parsePackagePath', () => {
  it('parses unscoped, scoped, and encoded-scoped packuments', () => {
    expect(parsePackagePath('/vite-plus')).toEqual({ name: 'vite-plus' })
    expect(parsePackagePath('/@voidzero-dev/vite-plus-core')).toEqual({
      name: '@voidzero-dev/vite-plus-core',
    })
    expect(parsePackagePath('/@voidzero-dev%2Fvite-plus-core')).toEqual({
      name: '@voidzero-dev/vite-plus-core',
    })
  })

  it('returns null for tarball/api/root paths', () => {
    expect(parsePackagePath('/')).toBeNull()
    expect(parsePackagePath('/vite/-/vite-5.0.0.tgz')).toBeNull()
    expect(parsePackagePath('/@scope/name/-/name-1.0.0.tgz')).toBeNull()
    expect(parsePackagePath('/-/v1/search?text=vite')).toBeNull()
  })
})

describe('parseTarballPath', () => {
  it('parses unscoped and scoped tarball paths', () => {
    expect(parseTarballPath('/tarballs/vite-plus/0.0.0-pr.1891.tgz')).toEqual({
      name: 'vite-plus',
      version: '0.0.0-pr.1891',
    })
    expect(
      parseTarballPath(
        '/tarballs/@voidzero-dev/vite-plus-core/0.0.0-pr.1891.tgz',
      ),
    ).toEqual({
      name: '@voidzero-dev/vite-plus-core',
      version: '0.0.0-pr.1891',
    })
    expect(
      parseTarballPath(
        '/tarballs/@voidzero-dev%2Fvite-plus-core/0.0.0-commit.a832a55.tgz',
      ),
    ).toEqual({
      name: '@voidzero-dev/vite-plus-core',
      version: '0.0.0-commit.a832a55',
    })
  })

  it('returns null for non-tarball paths', () => {
    expect(parseTarballPath('/vite-plus')).toBeNull()
    expect(parseTarballPath('/tarballs/vite-plus/0.0.0-pr.1891')).toBeNull()
  })
})

describe('parseNpmTarballPath', () => {
  it('parses npm-convention unscoped and scoped tarball paths', () => {
    expect(
      parseNpmTarballPath('/vite-plus/-/vite-plus-0.0.0-commit.a832a55.tgz'),
    ).toEqual({ name: 'vite-plus', version: '0.0.0-commit.a832a55' })
    expect(
      parseNpmTarballPath(
        '/@voidzero-dev/vite-plus-core/-/vite-plus-core-0.0.0-commit.a832a55.tgz',
      ),
    ).toEqual({
      name: '@voidzero-dev/vite-plus-core',
      version: '0.0.0-commit.a832a55',
    })
    // Encoded scope slash (some clients percent-encode the `/`).
    expect(
      parseNpmTarballPath(
        '/@voidzero-dev%2Fvite-plus-core/-/vite-plus-core-0.0.0-commit.a832a55.tgz',
      ),
    ).toEqual({
      name: '@voidzero-dev/vite-plus-core',
      version: '0.0.0-commit.a832a55',
    })
  })

  it('returns null when the path is not a tarball or the filename mismatches', () => {
    // No `/-/` separator (a packument request).
    expect(parseNpmTarballPath('/vite-plus')).toBeNull()
    // Filename does not start with the unscoped package name.
    expect(
      parseNpmTarballPath('/vite-plus/-/other-0.0.0-commit.a832a55.tgz'),
    ).toBeNull()
    // Missing .tgz suffix.
    expect(
      parseNpmTarballPath('/vite-plus/-/vite-plus-0.0.0-commit.a832a55'),
    ).toBeNull()
    // Registry API path.
    expect(parseNpmTarballPath('/-/v1/search?text=vite')).toBeNull()
  })
})

describe('encodeNpmPackageName', () => {
  it('encodes scoped slash, leaves unscoped', () => {
    expect(encodeNpmPackageName('@voidzero-dev/vite-plus-core')).toBe(
      '@voidzero-dev%2Fvite-plus-core',
    )
    expect(encodeNpmPackageName('vite-plus')).toBe('vite-plus')
  })
})

describe('isWorkspacePackage', () => {
  it('matches exact names and prefix patterns from config', () => {
    expect(isWorkspacePackage('vite-plus', env)).toBe(true)
    expect(isWorkspacePackage('@voidzero-dev/vite-plus-core', env)).toBe(true)
    expect(
      isWorkspacePackage('@voidzero-dev/vite-plus-darwin-arm64', env),
    ).toBe(true)
    expect(isWorkspacePackage('react', env)).toBe(false)
    expect(isWorkspacePackage('@voidzero-dev/other', env)).toBe(false)
  })

  it('falls back to PREVIEW_PACKAGES when unconfigured', () => {
    const e = { WORKSPACE_PACKAGES: '' }
    expect(isWorkspacePackage('vite-plus', e)).toBe(true)
    expect(isWorkspacePackage('@voidzero-dev/vite-plus-darwin-arm64', e)).toBe(
      false,
    )
  })
})

describe('pkgPrNewUrlToVersion', () => {
  const sha = '6acea1aa818e96365b5811d47360367ba18a3a05'

  it('maps a whitelisted pkg.pr.new URL to a synthetic version string', () => {
    expect(
      pkgPrNewUrlToVersion(
        `https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-darwin-arm64@${sha}`,
        env,
      ),
    ).toBe(`0.0.0-commit.${sha}`)
    // A PR-number URL is mutable -> not routed (left as the original URL).
    expect(
      pkgPrNewUrlToVersion(
        'https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-darwin-arm64@1891',
        env,
      ),
    ).toBeNull()
  })

  it('leaves non-workspace and non-pkg.pr.new specs alone', () => {
    expect(
      pkgPrNewUrlToVersion(
        `https://pkg.pr.new/voidzero-dev/vite-plus/@other/pkg@${sha}`,
        env,
      ),
    ).toBeNull()
    expect(pkgPrNewUrlToVersion('^2.3.1', env)).toBeNull()
    expect(
      pkgPrNewUrlToVersion('https://example.com/foo.tgz', env),
    ).toBeNull()
  })
})

describe('rewritePackageJson', () => {
  const sha = '6acea1aa818e96365b5811d47360367ba18a3a05'

  it('rewrites preview deps and pkg.pr.new URL optional deps to versions', () => {
    const out = rewritePackageJson(
      {
        name: 'vite-plus',
        version: '1891',
        dependencies: {
          '@voidzero-dev/vite-plus-core': '1891',
          picomatch: '^2.3.1',
        },
        peerDependencies: { vite: '^5.0.0' },
        optionalDependencies: {
          '@voidzero-dev/vite-plus-darwin-arm64': `https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-darwin-arm64@${sha}`,
        },
      },
      'vite-plus',
      '0.0.0-pr.1891',
      env,
    )
    expect(out.name).toBe('vite-plus')
    expect(out.version).toBe('0.0.0-pr.1891')
    expect(out.dependencies['@voidzero-dev/vite-plus-core']).toBe('0.0.0-pr.1891')
    expect(out.dependencies.picomatch).toBe('^2.3.1')
    expect(out.peerDependencies.vite).toBe('^5.0.0')
    expect(out.optionalDependencies['@voidzero-dev/vite-plus-darwin-arm64']).toBe(
      `0.0.0-commit.${sha}`,
    )
  })
})

describe('validateTarballPath', () => {
  it('flags traversal and absolute paths', () => {
    expect(() => assertSafeTarballPath('package/index.js')).not.toThrow()
    expect(() => assertSafeTarballPath('package/../etc/passwd')).toThrow()
    expect(() => assertSafeTarballPath('/etc/passwd')).toThrow()
  })

  it('detects the package/ root', () => {
    expect(isUnderPackageRoot('package/package.json')).toBe(true)
    expect(isUnderPackageRoot('./package/index.js')).toBe(true)
    expect(isUnderPackageRoot('other/file.js')).toBe(false)
  })
})

describe('buildVersionMetadata', () => {
  it('drops devDependencies, sets dist.tarball/_id/integrity', () => {
    const meta = buildVersionMetadata(env, 'vite-plus', '0.0.0-pr.1891', {
      packageJson: {
        name: 'vite-plus',
        version: '0.0.0-pr.1891',
        dependencies: { '@voidzero-dev/vite-plus-core': '0.0.0-pr.1891' },
        devDependencies: { typescript: '^5' },
        bin: { vp: './bin/vp' },
      },
      shasum: 'abc123',
      integrity: 'sha512-deadbeef',
    })
    expect(meta.devDependencies).toBeUndefined()
    expect(meta.bin).toEqual({ vp: './bin/vp' })
    expect(meta._id).toBe('vite-plus@0.0.0-pr.1891')
    expect(meta.dist.tarball).toBe(
      'https://bridge.example.com/tarballs/vite-plus/0.0.0-pr.1891.tgz',
    )
    expect(meta.dist.shasum).toBe('abc123')
    expect(meta.dist.integrity).toBe('sha512-deadbeef')
  })
})

describe('computeDigests', () => {
  it('computes SHA-1 shasum and SHA-512 SRI deterministically', async () => {
    const data = new TextEncoder().encode('abc')
    const d = await computeDigests(data)
    // Known SHA-1("abc").
    expect(d.shasum).toBe('a9993e364706816aba3e25717850c26c9cd0d89d')
    expect(d.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+=*$/)
    const again = await computeDigests(data)
    expect(again.integrity).toBe(d.integrity)
  })
})

describe('fetchUpstreamTarball', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Stub global fetch to return a multi-chunk stream (so both the pre-sized
   * and fallback paths do >1 read()), optionally with response headers.
   */
  function mockUpstream(chunks: Uint8Array[], headers?: HeadersInit): void {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk)
        controller.close()
      },
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream, { headers })),
    )
  }

  async function expectTooLarge(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toMatchObject({
      status: 413,
    } satisfies Partial<HttpError>)
  }

  it('streams into a pre-sized buffer when Content-Length is present', async () => {
    mockUpstream(
      [new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])],
      { 'content-length': '5' },
    )
    const out = await fetchUpstreamTarball('https://example.com/t.tgz', 1024)
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5])
  })

  it('falls back to chunk collection when Content-Length is absent', async () => {
    mockUpstream([new Uint8Array([9, 8, 7]), new Uint8Array([6])])
    const out = await fetchUpstreamTarball('https://example.com/t.tgz', 1024)
    expect(Array.from(out)).toEqual([9, 8, 7, 6])
  })

  it('rejects a declared Content-Length over the max', async () => {
    mockUpstream([new Uint8Array([1])], { 'content-length': '2000' })
    await expectTooLarge(fetchUpstreamTarball('https://example.com/t.tgz', 1024))
  })

  it('still succeeds when the body exceeds a Content-Length that understated it, within max', async () => {
    // Content-Length is a sizing hint, not a hard cap: an upstream/proxy that
    // under-reports it must not fail a download that is otherwise well within
    // the configured max.
    mockUpstream([new Uint8Array([1, 2, 3, 4])], { 'content-length': '2' })
    const out = await fetchUpstreamTarball('https://example.com/t.tgz', 1024)
    expect(Array.from(out)).toEqual([1, 2, 3, 4])
  })

  it('rejects a body exceeding the max with no Content-Length', async () => {
    mockUpstream([new Uint8Array(2000)])
    await expectTooLarge(fetchUpstreamTarball('https://example.com/t.tgz', 1024))
  })

  it('rejects a body exceeding the max even with an understated Content-Length', async () => {
    mockUpstream([new Uint8Array(2000)], { 'content-length': '1' })
    await expectTooLarge(fetchUpstreamTarball('https://example.com/t.tgz', 1024))
  })

  it('treats a blank Content-Length header as absent, not zero', async () => {
    mockUpstream([new Uint8Array([1, 2, 3])], { 'content-length': '' })
    const out = await fetchUpstreamTarball('https://example.com/t.tgz', 1024)
    expect(Array.from(out)).toEqual([1, 2, 3])
  })

  it('treats a non-integer Content-Length header as unknown', async () => {
    mockUpstream([new Uint8Array([1, 2, 3])], { 'content-length': '3.5' })
    const out = await fetchUpstreamTarball('https://example.com/t.tgz', 1024)
    expect(Array.from(out)).toEqual([1, 2, 3])
  })
})
