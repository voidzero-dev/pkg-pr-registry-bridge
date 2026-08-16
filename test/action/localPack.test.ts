import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'
import {
  assertValidBatch,
  expandPackageDirs,
  packDirectory,
  parsePackagesInput,
  readManifest,
} from '../../.github/actions/publish-preview/src/localPack'
import { buildPreviewTarball } from '../../src/tarball/buildPreviewTarball'

const SHA = '6acea1aa818e96365b5811d47360367ba18a3a05'
const VERSION = `0.0.0-commit.${SHA}`

// The workspace allowlist assertValidBatch validates against.
const env = {
  WORKSPACE_PACKAGES: 'vite-plus,@voidzero-dev/vite-plus-*',
}

let root: string

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

// A minimal pnpm workspace mirroring the vite-plus layout: two members (cli
// depends on prompts via workspace:*, a member that is NOT in
// PREVIEW_PACKAGES, so only batch rewriting can pin it) and a standalone
// platform dir that is not a workspace member (like packages/cli/npm/*).
// Only workspace-internal deps, so `pnpm install` needs no network.
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'bridge-action-test-'))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
  writeJson(join(root, 'package.json'), {
    name: 'fixture-root',
    version: '0.0.0',
    private: true,
  })

  mkdirSync(join(root, 'packages/prompts'), { recursive: true })
  writeJson(join(root, 'packages/prompts/package.json'), {
    name: '@voidzero-dev/vite-plus-prompts',
    version: '0.2.2',
    files: ['index.js'],
  })
  writeFileSync(join(root, 'packages/prompts/index.js'), 'module.exports = 1\n')

  mkdirSync(join(root, 'packages/cli'), { recursive: true })
  writeJson(join(root, 'packages/cli/package.json'), {
    name: 'vite-plus',
    version: '0.2.2',
    files: ['index.js'],
    dependencies: { '@voidzero-dev/vite-plus-prompts': 'workspace:*' },
  })
  writeFileSync(join(root, 'packages/cli/index.js'), 'module.exports = 2\n')

  // A platform package dir that is not a workspace member, plus a dir without
  // a package.json (napi's createNpmDirs can leave those) the glob must skip.
  mkdirSync(join(root, 'packages/cli/npm/darwin-arm64'), { recursive: true })
  writeJson(join(root, 'packages/cli/npm/darwin-arm64/package.json'), {
    name: '@voidzero-dev/vite-plus-darwin-arm64',
    version: '0.2.2',
    os: ['darwin'],
    cpu: ['arm64'],
    files: ['addon.node'],
  })
  writeFileSync(join(root, 'packages/cli/npm/darwin-arm64/addon.node'), 'bin\n')
  mkdirSync(join(root, 'packages/cli/npm/empty'), { recursive: true })

  execFileSync('pnpm', ['install', '--ignore-scripts', '--silent'], { cwd: root })
}, 120_000)

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('parsePackagesInput', () => {
  it('splits on newlines and commas, dropping blanks', () => {
    expect(parsePackagesInput('packages/cli\n packages/core ,packages/cli/npm/*\n\n')).toEqual([
      'packages/cli',
      'packages/core',
      'packages/cli/npm/*',
    ])
  })
})

describe('expandPackageDirs', () => {
  it('expands globs to package dirs and keeps explicit dirs', () => {
    const dirs = expandPackageDirs(['packages/cli', 'packages/cli/npm/*'], root)
    expect(dirs).toEqual([join(root, 'packages/cli'), join(root, 'packages/cli/npm/darwin-arm64')])
    expect(readManifest(dirs[1]).name).toBe('@voidzero-dev/vite-plus-darwin-arm64')
  })

  it('dedupes overlapping patterns', () => {
    const dirs = expandPackageDirs(['packages/*', 'packages/cli'], root)
    expect(dirs).toEqual([join(root, 'packages/cli'), join(root, 'packages/prompts')])
  })

  it('fails loudly on an explicit dir without a package.json', () => {
    expect(() => expandPackageDirs(['packages/nope'], root)).toThrow(/no package\.json/)
    expect(() => expandPackageDirs(['packages/nope/*'], root)).toThrow(/matched no directory/)
  })
})

describe('assertValidBatch', () => {
  const pkg = (name: string, deps?: Record<string, string>) => ({
    label: `/fixture/${name}`,
    manifest: { name, version: '0.2.2', ...(deps ? { dependencies: deps } : {}) },
  })

  it('returns the batch names when every workspace dep is covered', () => {
    const batch = assertValidBatch(
      [
        pkg('vite-plus', { '@voidzero-dev/vite-plus-prompts': '0.2.2', picomatch: '^2.3.1' }),
        pkg('@voidzero-dev/vite-plus-prompts'),
      ],
      env,
    )
    expect(batch).toEqual(new Set(['vite-plus', '@voidzero-dev/vite-plus-prompts']))
  })

  it('rejects an empty batch, non-workspace names, and duplicates', () => {
    expect(() => assertValidBatch([], env)).toThrow(/matched no package/)
    expect(() => assertValidBatch([pkg('left-pad')], env)).toThrow(
      /not an allowed workspace package/,
    )
    expect(() => assertValidBatch([pkg('vite-plus'), pkg('vite-plus')], env)).toThrow(
      /duplicate package/,
    )
  })

  it('rejects a workspace dep missing from the batch', () => {
    expect(() =>
      assertValidBatch([pkg('vite-plus', { '@voidzero-dev/vite-plus-prompts': '0.2.2' })], env),
    ).toThrow(/not in this publish batch/)
  })
})

describe('packDirectory', () => {
  it('packs a workspace member; the batch rewrite pins its workspace dep', async () => {
    const packed = await packDirectory(join(root, 'packages/cli'))

    // pnpm pack resolved `workspace:*` to the concrete version; a batch of just
    // vite-plus leaves that (unlisted) workspace dep alone.
    const solo = await buildPreviewTarball(packed, 'vite-plus', VERSION, new Set(['vite-plus']))
    expect(solo.packageJson.dependencies['@voidzero-dev/vite-plus-prompts']).toBe('0.2.2')

    // Publishing prompts in the same batch pins the dep to the synthetic
    // version, so the whole batch resolves through the bridge.
    const build = await buildPreviewTarball(
      packed,
      'vite-plus',
      VERSION,
      new Set(['vite-plus', '@voidzero-dev/vite-plus-prompts']),
    )
    expect(build.packageJson.version).toBe(VERSION)
    expect(build.packageJson.dependencies['@voidzero-dev/vite-plus-prompts']).toBe(VERSION)
    expect(build.integrity).toMatch(/^sha512-/)
    expect(build.shasum).toMatch(/^[0-9a-f]{40}$/)
  }, 60_000)

  it('packs a standalone platform dir that is not a workspace member', async () => {
    const packed = await packDirectory(join(root, 'packages/cli/npm/darwin-arm64'))
    const build = await buildPreviewTarball(
      packed,
      '@voidzero-dev/vite-plus-darwin-arm64',
      VERSION,
      new Set(['@voidzero-dev/vite-plus-darwin-arm64']),
    )
    expect(build.packageJson.version).toBe(VERSION)
    expect(build.packageJson.os).toEqual(['darwin'])
    expect(build.packageJson.cpu).toEqual(['arm64'])
  }, 60_000)
})
