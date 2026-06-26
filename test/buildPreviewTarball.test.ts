import { describe, expect, it } from 'vitest'
import { createTarGzip, parseTarGzip } from 'nanotar'
import { buildPreviewTarball } from '../src/tarball/buildPreviewTarball'

const decode = (data?: Uint8Array) => new TextDecoder().decode(data)

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
    const upstream = await makeUpstream({
      name: '@voidzero-dev/vite-plus-core',
      version: '1891',
      dependencies: { 'vite-plus': '1891', picomatch: '^2.3.1' },
      bin: { vp: './bin/vp' },
    })

    const build = await buildPreviewTarball(
      upstream,
      '@voidzero-dev/vite-plus-core',
      '0.0.0-pr.1891',
    )

    expect(build.packageJson.name).toBe('@voidzero-dev/vite-plus-core')
    expect(build.packageJson.version).toBe('0.0.0-pr.1891')
    expect(build.packageJson.dependencies['vite-plus']).toBe('0.0.0-pr.1891')
    expect(build.packageJson.dependencies.picomatch).toBe('^2.3.1')

    const files = await parseTarGzip(build.tarball)

    const pkgFile = files.find((f) => f.name === 'package/package.json')
    expect(pkgFile).toBeTruthy()
    expect(JSON.parse(decode(pkgFile!.data)).version).toBe('0.0.0-pr.1891')

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
      buildPreviewTarball(upstream, 'vite-plus', '0.0.0-pr.1891'),
    ).rejects.toThrow(/missing package\/package\.json/)
  })
})
