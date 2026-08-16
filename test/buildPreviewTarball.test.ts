import { describe, expect, it } from 'vite-plus/test'
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
    expect(build.packageJson.optionalDependencies['@voidzero-dev/vite-plus-darwin-arm64']).toBe(
      '0.0.0-commit.a832a55',
    )

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
    const upstream = await createTarGzip([{ name: 'package/README.md', data: '# hi\n' }])
    await expect(
      buildPreviewTarball(upstream, 'vite-plus', '0.0.0-commit.a832a55', new Set(['vite-plus'])),
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
      const stream = new Response(gz).body!.pipeThrough(new DecompressionStream('gzip'))
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
        new Set(['vite-plus']),
      )
      const tar = await gunzip(build.tarball)
      if (!endsWithMarker(tar)) offenders.push(tar.length)
    }

    expect(offenders).toEqual([])
  })
})

/**
 * The mode comes from the tar header, which is attacker-controlled for any
 * archive the bridge did not build. It used to pass straight through, so a
 * crafted tarball's setuid bit survived into the published one. "The bytes we
 * publish are ones we constructed" only holds if the metadata is ours too.
 */
describe('buildPreviewTarball: metadata normalization', () => {
  const pkg = { name: 'vite-plus', version: '1.0.0' }
  const batch = new Set(['vite-plus'])

  async function rebuiltAttrs(attrs: Record<string, unknown>): Promise<Record<string, any>> {
    const source = await createTarGzip([
      { name: 'package/package.json', data: JSON.stringify(pkg) },
      { name: 'package/bin/vp', data: '#!/bin/sh\n', attrs: attrs as never },
    ])
    const built = await buildPreviewTarball(source, 'vite-plus', '0.0.0-commit.abc1234', batch)
    const files = await parseTarGzip(built.tarball)
    return files.find((f) => f.name === 'package/bin/vp')!.attrs as Record<string, any>
  }

  /** The tar writer left-pads mode to 7 chars, so compare the octal value. */
  const modeOf = (attrs: Record<string, any>): number => Number.parseInt(attrs.mode, 8)

  it('strips the setuid bit', async () => {
    const attrs = await rebuiltAttrs({ mode: '4755' })
    expect(modeOf(attrs)).toBe(0o755)
  })

  it('strips setgid and sticky bits', async () => {
    expect(modeOf(await rebuiltAttrs({ mode: '2755' }))).toBe(0o755)
    expect(modeOf(await rebuiltAttrs({ mode: '1777' }))).toBe(0o755)
  })

  it('keeps executables executable', async () => {
    expect(modeOf(await rebuiltAttrs({ mode: '755' }))).toBe(0o755)
    expect(modeOf(await rebuiltAttrs({ mode: '700' }))).toBe(0o755)
  })

  it('normalizes non-executables to 644', async () => {
    expect(modeOf(await rebuiltAttrs({ mode: '666' }))).toBe(0o644)
    expect(modeOf(await rebuiltAttrs({ mode: '000' }))).toBe(0o644)
  })

  it('falls back to 644 for an unparseable mode', async () => {
    expect(modeOf(await rebuiltAttrs({ mode: 'zzz' }))).toBe(0o644)
  })

  it('flattens ownership, which describes the packing machine only', async () => {
    const attrs = await rebuiltAttrs({
      mode: '755',
      uid: 501,
      gid: 20,
      user: 'attacker',
      group: 'wheel',
    })
    expect(attrs.uid).toBe(0)
    expect(attrs.gid).toBe(0)
    expect(attrs.user).toBe('')
    expect(attrs.group).toBe('')
  })
})

/**
 * Determinism is what makes the content-addressed store behave: identical
 * content must land on the same key rather than accumulating one object per
 * republish. That needs both a fixed mtime and a gzip layer that does not
 * stamp the current time into its header.
 */
describe('buildPreviewTarball: reproducibility', () => {
  const pkg = { name: 'vite-plus', version: '1.0.0' }
  const batch = new Set(['vite-plus'])
  const version = '0.0.0-commit.abc1234'

  const source = (mtime: number) =>
    createTarGzip([
      { name: 'package/package.json', data: JSON.stringify(pkg), attrs: { mtime } as never },
      { name: 'package/index.js', data: 'export const x = 1\n', attrs: { mtime } as never },
    ])

  it('produces identical bytes for identical content', async () => {
    const a = await buildPreviewTarball(await source(1e12), 'vite-plus', version, batch)
    const b = await buildPreviewTarball(await source(1e12), 'vite-plus', version, batch)
    expect(b.shasum).toBe(a.shasum)
    expect(b.integrity).toBe(a.integrity)
  })

  it('leaves no wall-clock timestamp in the gzip header', async () => {
    // The gzip header carries its own MTIME field. Asserting it is zeroed
    // covers second-granularity nondeterminism directly, instead of sleeping
    // through a wall-clock second on every test run to try to observe it.
    const built = await buildPreviewTarball(await source(1e12), 'vite-plus', version, batch)
    expect(Array.from(built.tarball.slice(4, 8))).toEqual([0, 0, 0, 0])
  })

  it('erases a source mtime, so hostile timestamps cannot vary the output', async () => {
    // Two archives differing ONLY in mtime must rebuild to the same bytes,
    // otherwise an untrusted archive could mint unlimited distinct CAS keys.
    const a = await buildPreviewTarball(await source(1e12), 'vite-plus', version, batch)
    const b = await buildPreviewTarball(await source(4e12), 'vite-plus', version, batch)
    expect(b.shasum).toBe(a.shasum)
  })

  it('stamps the node-tar portable mtime that pnpm pack already uses', async () => {
    const built = await buildPreviewTarball(await source(1e12), 'vite-plus', version, batch)
    const files = await parseTarGzip(built.tarball)
    for (const file of files) {
      // nanotar's parser reports SECONDS while its writer takes MILLISECONDS.
      // That asymmetry is why passing parsed attrs straight back to the writer
      // divided by 1000 twice and wrote 1970-01-06; pin the round-tripped value
      // so a regression there is caught here.
      expect(file.attrs?.mtime).toBe(499_162_500)
      expect(new Date(499_162_500 * 1000).toISOString()).toBe('1985-10-26T08:15:00.000Z')
    }
  })
})
