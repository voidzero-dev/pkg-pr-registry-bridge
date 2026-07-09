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
      optionalDependencies: {
        '@voidzero-dev/vite-plus-darwin-arm64': '1891',
      },
      bin: { vp: './bin/vp' },
    })

    const build = await buildPreviewTarball(
      upstream,
      '@voidzero-dev/vite-plus-core',
      '0.0.0-commit.a832a55',
      new Set([
        '@voidzero-dev/vite-plus-core',
        'vite-plus',
        '@voidzero-dev/vite-plus-darwin-arm64',
      ]),
    )

    expect(build.packageJson.name).toBe('@voidzero-dev/vite-plus-core')
    expect(build.packageJson.version).toBe('0.0.0-commit.a832a55')
    expect(build.packageJson.dependencies['vite-plus']).toBe('0.0.0-commit.a832a55')
    expect(build.packageJson.dependencies.picomatch).toBe('^2.3.1')
    // batch-member deps are pinned to the synthetic version.
    expect(
      build.packageJson.optionalDependencies['@voidzero-dev/vite-plus-darwin-arm64'],
    ).toBe('0.0.0-commit.a832a55')

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
      buildPreviewTarball(upstream, 'vite-plus', '0.0.0-commit.a832a55'),
    ).rejects.toThrow(/missing package\/package\.json/)
  })

  // Regression: a tar archive must end with two 512-byte all-zero blocks
  // (the end-of-archive marker). nanotar rounds the archive up to a full
  // 10240-byte record and the zero slack forms that marker, EXCEPT when the
  // packed size is already an exact multiple of 10240, where it emitted no
  // marker at all. Lenient tools (BSD/GNU tar) tolerate the omission, but
  // pnpm's strict extractor reads a header past EOF and fails with
  // ERR_PNPM_TARBALL_EXTRACT ("Invalid checksum ... Expected 0, got NaN").
  // See @voidzero-dev/vite-plus-core@0.0.0-commit.14f13284 (packed to exactly
  // 5038080 = 492 * 10240 bytes).
  it('always emits a valid end-of-archive marker, even on a 10240-byte boundary', async () => {
    async function gunzip(gz: Uint8Array): Promise<Uint8Array> {
      const stream = new Response(gz).body!.pipeThrough(
        new DecompressionStream('gzip'),
      )
      return new Uint8Array(await new Response(stream).arrayBuffer())
    }

    const endsWithMarker = (tar: Uint8Array): boolean => {
      if (tar.length < 1024 || tar.length % 512 !== 0) return false
      return tar.subarray(tar.length - 1024).every((b) => b === 0)
    }

    // Sweep the packed size across a full 10240-byte record by growing one
    // filler file 512 bytes at a time. 20 consecutive block counts cover every
    // 512-aligned residue mod 10240, so exactly one lands on the boundary that
    // triggered the bug; assert the marker is present for all of them.
    const offenders: number[] = []
    for (let blocks = 1; blocks <= 20; blocks++) {
      const upstream = await createTarGzip([
        {
          name: 'package/package.json',
          data: JSON.stringify({ name: 'vite-plus', version: '1891' }),
        },
        { name: 'package/filler.bin', data: new Uint8Array(blocks * 512).fill(65) },
      ])
      const build = await buildPreviewTarball(
        upstream,
        'vite-plus',
        '0.0.0-commit.a832a55',
      )
      const tar = await gunzip(build.tarball)
      if (!endsWithMarker(tar)) offenders.push(tar.length)
    }

    expect(offenders).toEqual([])
  })
})
