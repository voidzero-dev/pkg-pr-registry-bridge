import { afterEach, describe, expect, it, vi } from 'vitest'
import { verifyRefExists } from '../src/github/verifyRef'
import {
  refsFromBotComment,
  verifyGitHubSignature,
} from '../src/github/webhook'
import {
  isPreviewVersion,
  parsePreviewVersion,
} from '../src/preview/parsePreviewVersion'
import {
  parseConfiguredPreviewRefs,
  parseConfiguredPreviewRefsSafe,
} from '../src/preview/parseConfiguredPreviewRefs'
import { toPkgPrNewUrl } from '../src/preview/toPkgPrNewUrl'
import {
  encodeNpmPackageName,
  parsePackagePath,
  parseTarballPath,
} from '../src/registry/parsePackageName'
import { rewritePackageJson } from '../src/tarball/rewritePackageJson'
import {
  assertSafeTarballPath,
  isUnderPackageRoot,
} from '../src/security/validateTarballPath'
import { buildVersionMetadata } from '../src/registry/buildVersionMetadata'
import { computeDigests } from '../src/tarball/digests'
import type { Env } from '../src/config'

const env = {
  PKG_PR_NEW_BASE: 'https://pkg.pr.new',
  PREVIEW_OWNER: 'voidzero-dev',
  PREVIEW_REPO: 'vite-plus',
  PUBLIC_BASE_URL: 'https://bridge.example.com',
} as Env

describe('parsePreviewVersion', () => {
  it('parses pr versions', () => {
    expect(parsePreviewVersion('0.0.0-pr.1891')).toEqual({
      type: 'pr',
      ref: '1891',
    })
  })

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

  it('rejects non-preview and malformed versions', () => {
    for (const v of [
      '0.2.1',
      'latest',
      '1891',
      'pr-1891',
      '0.2.1-pr.1891',
      '0.0.0-pr.abc',
      '0.0.0-commit.xyz',
      '0.0.0-commit.abc', // < 7 hex chars
    ]) {
      expect(parsePreviewVersion(v), v).toBeNull()
    }
    expect(isPreviewVersion('0.0.0-pr.1')).toBe(true)
    expect(isPreviewVersion('0.2.1')).toBe(false)
  })
})

describe('parseConfiguredPreviewRefs', () => {
  it('parses pr and commit refs into versions and tags', () => {
    expect(parseConfiguredPreviewRefs('pr.1891,commit.a832a55')).toEqual([
      { type: 'pr', ref: '1891', version: '0.0.0-pr.1891', tag: 'pr-1891' },
      {
        type: 'commit',
        ref: 'a832a55',
        version: '0.0.0-commit.a832a55',
        tag: 'commit-a832a55',
      },
    ])
  })

  it('returns [] for empty input', () => {
    expect(parseConfiguredPreviewRefs('')).toEqual([])
    expect(parseConfiguredPreviewRefs(undefined)).toEqual([])
  })

  it('throws on invalid ref (strict) but skips it (safe)', () => {
    expect(() => parseConfiguredPreviewRefs('bogus')).toThrow()
    expect(parseConfiguredPreviewRefsSafe('pr.1,bogus,commit.abcdef0')).toEqual([
      { type: 'pr', ref: '1', version: '0.0.0-pr.1', tag: 'pr-1' },
      {
        type: 'commit',
        ref: 'abcdef0',
        version: '0.0.0-commit.abcdef0',
        tag: 'commit-abcdef0',
      },
    ])
  })
})

describe('toPkgPrNewUrl', () => {
  it('maps scoped and unscoped names', () => {
    expect(
      toPkgPrNewUrl(env, '@voidzero-dev/vite-plus-core', '0.0.0-pr.1891'),
    ).toBe(
      'https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-core@1891',
    )
    expect(toPkgPrNewUrl(env, 'vite-plus', '0.0.0-pr.1891')).toBe(
      'https://pkg.pr.new/voidzero-dev/vite-plus/vite-plus@1891',
    )
    expect(toPkgPrNewUrl(env, 'vite-plus', '0.0.0-commit.a832a55')).toBe(
      'https://pkg.pr.new/voidzero-dev/vite-plus/vite-plus@a832a55',
    )
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

describe('encodeNpmPackageName', () => {
  it('encodes scoped slash, leaves unscoped', () => {
    expect(encodeNpmPackageName('@voidzero-dev/vite-plus-core')).toBe(
      '@voidzero-dev%2Fvite-plus-core',
    )
    expect(encodeNpmPackageName('vite-plus')).toBe('vite-plus')
  })
})

describe('rewritePackageJson', () => {
  it('sets name/version and rewrites preview deps only', () => {
    const out = rewritePackageJson(
      {
        name: 'vite-plus',
        version: '1891',
        dependencies: {
          '@voidzero-dev/vite-plus-core': '1891',
          picomatch: '^2.3.1',
        },
        peerDependencies: { vite: '^5.0.0' },
      },
      'vite-plus',
      '0.0.0-pr.1891',
    )
    expect(out.name).toBe('vite-plus')
    expect(out.version).toBe('0.0.0-pr.1891')
    expect(out.dependencies['@voidzero-dev/vite-plus-core']).toBe('0.0.0-pr.1891')
    expect(out.dependencies.picomatch).toBe('^2.3.1')
    expect(out.peerDependencies.vite).toBe('^5.0.0')
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

describe('verifyRefExists', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('hits the right GitHub endpoint and maps 200/404', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', (url: string) => {
      calls.push(url)
      const status = url.endsWith('/pulls/1') ? 200 : 404
      return Promise.resolve(new Response('', { status }))
    })
    const ghEnv = { PREVIEW_OWNER: 'voidzero-dev', PREVIEW_REPO: 'vite-plus' } as Env

    expect(
      await verifyRefExists(ghEnv, {
        type: 'pr',
        ref: '1',
        version: '0.0.0-pr.1',
        tag: 'pr-1',
      }),
    ).toBe(true)
    expect(calls[0]).toBe(
      'https://api.github.com/repos/voidzero-dev/vite-plus/pulls/1',
    )

    expect(
      await verifyRefExists(ghEnv, {
        type: 'commit',
        ref: 'abcdef0',
        version: '0.0.0-commit.abcdef0',
        tag: 'commit-abcdef0',
      }),
    ).toBe(false)
    expect(calls[1]).toBe(
      'https://api.github.com/repos/voidzero-dev/vite-plus/commits/abcdef0',
    )
  })
})

describe('refsFromBotComment', () => {
  it('extracts the PR ref and distinct commit shas', () => {
    const sha = '6acea1aa818e96365b5811d47360367ba18a3a05'
    const body = [
      '```',
      'npm i https://pkg.pr.new/voidzero-dev/vite-plus@1891',
      '```',
      `npm i https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-darwin-arm64@${sha}`,
      `npm i https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-linux-x64-gnu@${sha}`,
    ].join('\n')
    expect(refsFromBotComment(body, 1891)).toEqual([
      'pr.1891',
      `commit.${sha}`,
    ])
  })
})

describe('verifyGitHubSignature', () => {
  it('accepts a correct HMAC and rejects a wrong one', async () => {
    const secret = 'shh'
    const body = '{"hello":"world"}'
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

    expect(await verifyGitHubSignature(secret, body, `sha256=${hex}`)).toBe(true)
    expect(await verifyGitHubSignature(secret, body, `sha256=${'0'.repeat(64)}`)).toBe(false)
    expect(await verifyGitHubSignature(secret, body, 'garbage')).toBe(false)
  })
})
