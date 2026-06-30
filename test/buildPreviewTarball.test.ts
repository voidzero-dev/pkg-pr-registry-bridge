import { describe, expect, it } from 'vitest'
import { createTarGzip, parseTarGzip } from 'nanotar'
import { buildPreviewTarball } from '../src/tarball/buildPreviewTarball'
import type { RewriteEnv } from '../src/tarball/rewritePackageJson'

const decode = (data?: Uint8Array) => new TextDecoder().decode(data)

const env: RewriteEnv = {
  PKG_PR_NEW_BASE: 'https://pkg.pr.new',
  PREVIEW_OWNER: 'voidzero-dev',
  PREVIEW_REPO: 'vite-plus',
  PUBLIC_BASE_URL: 'https://bridge.example.com',
  WORKSPACE_PACKAGES: 'vite-plus,@voidzero-dev/vite-plus-*',
}

async function makeUpstream(pkg: Record<string, any>) {
  return createTarGzip([
    { name: 'package/package.json', data: JSON.stringify(pkg) },
    {
      name: 'package/bin/vp',
      data: '#!/usr/bin/env node\n',
      attrs: { mode: '755' },
    },
    { name: 'package/dist/index.js', data: 'export const x = 1\n' },
  ])
}

describe('buildPreviewTarball', () => {
  it('rewrites package.json name/version/deps and preserves other files', async () => {
    const binSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const upstream = await makeUpstream({
      name: '@voidzero-dev/vite-plus-core',
      version: '1891',
      dependencies: { 'vite-plus': '1891', picomatch: '^2.3.1' },
      optionalDependencies: {
        '@voidzero-dev/vite-plus-darwin-arm64': `https://pkg.pr.new/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-darwin-arm64@${binSha}`,
      },
      bin: { vp: './bin/vp' },
    })

    const build = await buildPreviewTarball(
      upstream,
      '@voidzero-dev/vite-plus-core',
      '0.0.0-commit.a832a55',
    env,
    )

    expect(build.packageJson.name).toBe('@voidzero-dev/vite-plus-core')
    expect(build.packageJson.version).toBe('0.0.0-commit.a832a55')
    expect(build.packageJson.dependencies['vite-plus']).toBe('0.0.0-commit.a832a55')
    expect(build.packageJson.dependencies.picomatch).toBe('^2.3.1')
    // pkg.pr.new optionalDependency URLs are rewritten to version strings.
    expect(
      build.packageJson.optionalDependencies['@voidzero-dev/vite-plus-darwin-arm64'],
    ).toBe(`0.0.0-commit.${binSha}`)

    const files = await parseTarGzip(build.tarball)

    const pkgFile = files.find((f) => f.name === 'package/package.json')
    expect(pkgFile).toBeTruthy()
    expect(JSON.parse(decode(pkgFile!.data)).version).toBe('0.0.0-commit.a832a55')

    const index = files.find((f) => f.name === 'package/dist/index.js')
    expect(decode(index!.data)).toBe('export const x = 1\n')

    const bin = files.find((f) => f.name === 'package/bin/vp')
    expect(bin).toBeTruthy()
    expect(bin!.attrs?.mode).toContain('755')
  })

  it('throws 422 when package/package.json is missing', async () => {
    const upstream = await createTarGzip([
      { name: 'package/README.md', data: '# hi\n' },
    ])
    await expect(
      buildPreviewTarball(upstream, 'vite-plus', '0.0.0-commit.a832a55', env),
    ).rejects.toThrow(/missing package\/package\.json/)
  })
})
