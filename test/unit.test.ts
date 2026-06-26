import { describe, expect, it } from 'vitest'
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
  it('drops devDependencies, sets dist.tarball and _id', () => {
    const meta = buildVersionMetadata(env, 'vite-plus', '0.0.0-pr.1891', {
      name: 'vite-plus',
      version: '0.0.0-pr.1891',
      dependencies: { '@voidzero-dev/vite-plus-core': '0.0.0-pr.1891' },
      devDependencies: { typescript: '^5' },
      bin: { vp: './bin/vp' },
    })
    expect(meta.devDependencies).toBeUndefined()
    expect(meta.bin).toEqual({ vp: './bin/vp' })
    expect(meta._id).toBe('vite-plus@0.0.0-pr.1891')
    expect(meta.dist.tarball).toBe(
      'https://bridge.example.com/tarballs/vite-plus/0.0.0-pr.1891.tgz',
    )
  })
})
