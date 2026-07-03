/**
 * Local packing for the publish action: expand the `packages` input into
 * concrete directories and pack each with `pnpm pack`. pnpm (not npm) because
 * it resolves `workspace:`/`catalog:` specs to concrete versions the way a
 * real publish would, which requires the workspace to be installed
 * (`pnpm install`) before the action runs.
 */
import { execFile } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** Split the `packages` input (newline- or comma-separated) into patterns. */
export function parsePackagesInput(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function hasPackageJson(dir: string): boolean {
  try {
    return statSync(join(dir, 'package.json')).isFile()
  } catch {
    return false
  }
}

/**
 * Expand package patterns into directories containing a package.json. A
 * pattern ending in `/*` matches every direct subdirectory that has one
 * (subdirectories without one are skipped: which platform dirs exist varies
 * per build); any other pattern must itself be such a directory, so a typo
 * fails loudly instead of silently publishing fewer packages.
 */
export function expandPackageDirs(patterns: string[], cwd: string): string[] {
  const dirs: string[] = []
  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const parent = resolve(cwd, pattern.slice(0, -2))
      let entries: string[]
      try {
        entries = readdirSync(parent)
      } catch {
        throw new Error(`packages pattern matched no directory: ${pattern}`)
      }
      for (const entry of entries.sort()) {
        const dir = join(parent, entry)
        if (hasPackageJson(dir)) dirs.push(dir)
      }
    } else {
      const dir = resolve(cwd, pattern)
      if (!hasPackageJson(dir)) {
        throw new Error(`not a package directory (no package.json): ${pattern}`)
      }
      dirs.push(dir)
    }
  }
  return [...new Set(dirs)]
}

/** Read a directory's package.json (the manifest as authored on disk). */
export function readManifest(dir: string): Record<string, any> {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
}

/** Pack one directory with `pnpm pack` and return the gzipped tarball bytes. */
export async function packDirectory(dir: string): Promise<Uint8Array> {
  const dest = mkdtempSync(join(tmpdir(), 'bridge-pack-'))
  try {
    await execFileAsync('pnpm', ['pack', '--pack-destination', dest], {
      cwd: dir,
    })
    const tgzs = readdirSync(dest).filter((f) => f.endsWith('.tgz'))
    if (tgzs.length !== 1) {
      throw new Error(
        `expected pnpm pack to produce one tarball for ${dir}, found ${tgzs.length}`,
      )
    }
    return new Uint8Array(readFileSync(join(dest, tgzs[0])))
  } finally {
    rmSync(dest, { recursive: true, force: true })
  }
}
