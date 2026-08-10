/**
 * The artifact contract between the two publish legs (RFC 0002 section 7).
 *
 * `pack` mode writes raw `pnpm pack` output here and an untrusted job uploads
 * the directory as a workflow artifact; `upload` mode reads it back in the
 * trusted job. Everything in this directory is attacker-controlled whenever the
 * build ran for a fork pull request, so:
 *
 *  - tarballs are stored under generated names (`pkg-0.tgz`), never a name
 *    derived from package.json, so nothing in the archive can influence a path;
 *  - `manifest.json` is advisory only. The version comes from the trusted
 *    `sha` input and every package name is read back out of the validated
 *    tarball, so a rewritten manifest changes nothing that matters;
 *  - the reader refuses symlinks, so the artifact cannot point at files outside
 *    itself.
 */
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

/** Advisory description of a packed batch. Never trusted by the reader. */
export interface PackManifest {
  /** `commit.<sha>` the pack ran for. Re-derived by the trusted leg. */
  ref: string
  /** `0.0.0-commit.<sha>`. Re-derived by the trusted leg. */
  version: string
  /** One entry per packed tarball, for human inspection of a failed run. */
  packages: Array<{ file: string; name: string; dir: string }>
}

export const MANIFEST_NAME = 'manifest.json'

/**
 * Ceiling on how many packages one artifact may carry. The vite-plus batch is
 * ~11; this leaves room to grow while stopping a modified build workflow from
 * handing the trusted leg tens of thousands of small archives to validate.
 */
export const MAX_ARTIFACT_PACKAGES = 128

/**
 * Ceiling on one COMPRESSED tarball, enforced from the directory entry before
 * the file is read. `gunzipBounded` bounds the inflated size, but only after
 * `readFileSync` has already materialized the compressed input, so a
 * multi-gigabyte `pkg-0.tgz` would exhaust the runner before that check runs.
 * The largest real package is ~23MB.
 */
export const MAX_COMPRESSED_BYTES = 128 * 1024 * 1024

/** The generated name for the nth packed tarball. */
export function tarballFileName(index: number): string {
  return `pkg-${index}.tgz`
}

/** Does this file name belong to a pack run (as opposed to a user's file)? */
function isActionOutput(entry: string): boolean {
  return entry === MANIFEST_NAME || /^pkg-\d+\.tgz$/.test(entry)
}

/**
 * Create `dir` and remove this action's own outputs from any previous run.
 *
 * Packing writes `pkg-0..N`, so a rerun that produces FEWER packages than the
 * last one would otherwise leave the higher indices behind. The upload leg
 * enumerates every `pkg-<n>.tgz` it finds and ignores `manifest.json`, so those
 * leftovers would be republished under the new commit version, or collide as a
 * duplicate package name and fail the run. CI gets a clean runner, but local
 * runs and `pnpm warm` reuse a workspace.
 *
 * Only action-owned names are removed. Anything else in the directory is left
 * alone and will make the upload leg refuse the artifact, which is better than
 * this quietly deleting a file it did not create.
 */
export function prepareOutputDir(dir: string): void {
  mkdirSync(dir, { recursive: true })
  for (const entry of readdirSync(dir)) {
    if (isActionOutput(entry)) rmSync(join(dir, entry), { force: true })
  }
}

export function writeManifest(dir: string, manifest: PackManifest): void {
  writeFileSync(
    join(dir, MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
}

/**
 * List the tarballs in an artifact directory, in a stable order.
 *
 * Only regular files matching the generated `pkg-<n>.tgz` shape are returned:
 * a symlink (which could point anywhere on the runner), a subdirectory, or a
 * stray file is refused rather than skipped, so a tampered artifact fails the
 * run instead of silently publishing a subset.
 */
export function readArtifactTarballs(dir: string): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    throw new Error(`input-dir is not a readable directory: ${dir}`)
  }

  const tarballs: Array<{ index: number; path: string }> = []
  for (const entry of entries) {
    if (entry === MANIFEST_NAME) continue
    const full = join(dir, entry)
    // lstat, NOT stat: stat would follow a symlink and report the target.
    const stat = lstatSync(full)
    if (stat.isSymbolicLink()) {
      throw new Error(`refusing symlink in input-dir: ${entry}`)
    }
    if (!stat.isFile()) {
      throw new Error(`unexpected non-file entry in input-dir: ${entry}`)
    }
    const match = entry.match(/^pkg-(\d+)\.tgz$/)
    if (!match) {
      throw new Error(`unexpected file in input-dir: ${entry}`)
    }
    // Bound the compressed size HERE, from the directory entry, because the
    // inflate bound cannot help once readFileSync has loaded the whole file.
    if (stat.size > MAX_COMPRESSED_BYTES) {
      throw new Error(
        `${entry} is ${stat.size} bytes compressed, over the ${MAX_COMPRESSED_BYTES} byte limit`,
      )
    }
    tarballs.push({ index: Number(match[1]), path: full })
  }

  if (tarballs.length === 0) {
    throw new Error(`input-dir contains no packed tarballs: ${dir}`)
  }
  if (tarballs.length > MAX_ARTIFACT_PACKAGES) {
    throw new Error(
      `input-dir has ${tarballs.length} packages, over the ${MAX_ARTIFACT_PACKAGES} limit`,
    )
  }
  return tarballs.sort((a, b) => a.index - b.index).map((t) => t.path)
}

export function readTarball(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path))
}
