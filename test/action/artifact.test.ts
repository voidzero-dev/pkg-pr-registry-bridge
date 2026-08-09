/**
 * The artifact directory is attacker-controlled whenever the build leg ran for
 * a fork PR, so the reader refuses anything it did not expect rather than
 * skipping it: a silently ignored entry would publish a subset of the batch and
 * look like success.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANIFEST_NAME,
  prepareOutputDir,
  readArtifactTarballs,
  tarballFileName,
  writeManifest,
} from '../../.github/actions/publish-preview/src/artifact'
import { existsSync } from 'node:fs'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-artifact-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function packed(index: number, body = 'x'): void {
  writeFileSync(join(dir, tarballFileName(index)), body)
}

describe('readArtifactTarballs', () => {
  it('returns tarballs in pack order, not readdir order', () => {
    // Written out of order and named so a lexical sort would give 0, 10, 2.
    for (const i of [2, 10, 0]) packed(i)
    expect(readArtifactTarballs(dir).map((p) => p.split('/').pop())).toEqual([
      'pkg-0.tgz',
      'pkg-2.tgz',
      'pkg-10.tgz',
    ])
  })

  it('ignores the manifest', () => {
    packed(0)
    writeManifest(dir, { ref: 'commit.abc1234', version: '0.0.0-commit.abc1234', packages: [] })
    expect(readArtifactTarballs(dir)).toHaveLength(1)
  })

  it('refuses a symlink', () => {
    packed(0)
    symlinkSync('/etc/passwd', join(dir, 'pkg-1.tgz'))
    expect(() => readArtifactTarballs(dir)).toThrow(/refusing symlink/)
  })

  it('refuses a symlinked directory', () => {
    packed(0)
    symlinkSync(tmpdir(), join(dir, 'pkg-1.tgz'))
    expect(() => readArtifactTarballs(dir)).toThrow(/refusing symlink/)
  })

  it('refuses an unexpected file rather than skipping it', () => {
    packed(0)
    writeFileSync(join(dir, 'payload.sh'), '#!/bin/sh\n')
    expect(() => readArtifactTarballs(dir)).toThrow(/unexpected file/)
  })

  it('refuses a subdirectory', () => {
    packed(0)
    mkdirSync(join(dir, 'nested'))
    expect(() => readArtifactTarballs(dir)).toThrow(/unexpected/)
  })

  it('refuses an empty directory', () => {
    expect(() => readArtifactTarballs(dir)).toThrow(/no packed tarballs/)
  })

  it('refuses a missing directory', () => {
    expect(() => readArtifactTarballs(join(dir, 'nope'))).toThrow(/not a readable directory/)
  })

  it('round-trips a manifest without being trusted for it', () => {
    packed(0)
    writeManifest(dir, {
      ref: 'commit.abc1234',
      version: '0.0.0-commit.abc1234',

      packages: [{ file: tarballFileName(0), name: 'vite-plus', dir: 'packages/cli' }],
    })
    // The reader returns tarball paths only; nothing from the manifest selects
    // what gets published.
    expect(readArtifactTarballs(dir).every((p) => !p.endsWith(MANIFEST_NAME))).toBe(true)
  })
})

/**
 * Packing writes pkg-0..N. A rerun producing FEWER packages would otherwise
 * leave the higher indices behind, and the upload leg enumerates every
 * pkg-<n>.tgz it finds, so a stale one would be republished under the new
 * commit version or collide as a duplicate package name.
 */
describe('prepareOutputDir', () => {
  it('removes stale tarballs from a previous, larger run', () => {
    for (const i of [0, 1, 2, 3, 4]) packed(i)
    writeManifest(dir, { ref: 'commit.old', version: 'old', packages: [] })

    prepareOutputDir(dir)

    expect(readdirSync(dir)).toEqual([])
  })

  it('creates the directory when it does not exist', () => {
    const nested = join(dir, 'deep', 'nested')
    prepareOutputDir(nested)
    expect(existsSync(nested)).toBe(true)
  })

  it('leaves files it did not create alone', () => {
    // Better to let the upload leg refuse an unexpected file than to have pack
    // silently delete something a user put there.
    packed(0)
    writeFileSync(join(dir, 'notes.txt'), 'keep me')
    prepareOutputDir(dir)
    expect(readdirSync(dir)).toEqual(['notes.txt'])
  })

  it('makes a shrinking rerun publish only the new set', () => {
    for (const i of [0, 1, 2]) packed(i, 'old')
    prepareOutputDir(dir)
    packed(0, 'new')
    expect(readArtifactTarballs(dir).map((p) => p.split('/').pop())).toEqual(['pkg-0.tgz'])
  })
})
