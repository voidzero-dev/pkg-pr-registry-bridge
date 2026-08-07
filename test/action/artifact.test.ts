/**
 * The artifact directory is attacker-controlled whenever the build leg ran for
 * a fork PR, so the reader refuses anything it did not expect rather than
 * skipping it: a silently ignored entry would publish a subset of the batch and
 * look like success.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MANIFEST_NAME,
  readArtifactTarballs,
  tarballFileName,
  writeManifest,
} from '../../.github/actions/publish-preview/src/artifact'

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
    writeManifest(dir, { ref: 'commit.abc1234', version: '0.0.0-commit.abc1234', files: [], packages: [] })
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
      files: [tarballFileName(0)],
      packages: [{ file: tarballFileName(0), name: 'vite-plus', dir: 'packages/cli' }],
    })
    // The reader returns tarball paths only; nothing from the manifest selects
    // what gets published.
    expect(readArtifactTarballs(dir).every((p) => !p.endsWith(MANIFEST_NAME))).toBe(true)
  })
})
