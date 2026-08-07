/**
 * Canonical archive policy for tarballs the bridge did not produce
 * (RFC 0002 SR-6).
 *
 * The trusted publish leg reads tarballs out of an artifact built by an
 * untrusted job, so this validates them against a strict shape before anything
 * downstream reads their contents. The output of validation feeds
 * `buildPreviewTarball`, which emits a fresh archive: the bytes published are
 * always ones we constructed, never the ones handed to us.
 *
 * The duplicate-entry rules are the reason this exists. Tar permits repeated
 * paths and extractors disagree about which wins, most taking the last; the
 * `find()` that locates `package/package.json` takes the first. A crafted
 * archive with two manifests could therefore pass a name/version check on one
 * while pnpm extracts the other. Rejecting duplicates outright removes the
 * disagreement rather than trying to match every extractor's precedence.
 *
 * On the path checks specifically: nanotar's parser already runs its own
 * `_sanitizePath` over every entry name, resolving `..` by popping and
 * stripping a leading `/` or `C:/`, so an escaping name normally arrives here
 * already flattened and is refused for landing outside `package/`. The
 * traversal, absolute-path and drive-letter checks below therefore rarely fire
 * in practice. They are kept because this module's job is to be the thing that
 * refuses regardless of what the tar library does, and because collapsing `..`
 * can itself create a collision (`package/x/../a.js` and `package/a.js` land on
 * one name), which the duplicate rule then catches.
 */
import { parseTar, type ParsedTarFileItem } from 'nanotar'
import { HttpError } from '../httpError'
import { assertSafeTarballPath, isUnderPackageRoot } from '../security/validateTarballPath'
import { PACKAGE_JSON_NAMES } from './buildPreviewTarball'

/** Limits applied to one package tarball. */
export interface ArchivePolicy {
  /** Cap on entry count, against an archive that bombs by inode count. */
  maxEntries: number
  /** Cap on any single decompressed file. */
  maxFileBytes: number
  /** Cap on the decompressed archive, enforced while inflating. */
  maxTotalBytes: number
}

/**
 * Sized against the real workload: the largest vite-plus platform binary
 * package runs ~19MB compressed, and the CLI package carries a few thousand
 * files. These are an order of magnitude above that, so they bound abuse
 * without tracking normal growth.
 */
export const DEFAULT_ARCHIVE_POLICY: ArchivePolicy = {
  maxEntries: 20_000,
  maxFileBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
}

/** Tar entry types an npm package tarball may contain. Everything else is out. */
const ALLOWED_ENTRY_TYPES = new Set(['file', 'directory', 'contiguousFile'])

function reject(message: string): never {
  throw new HttpError(422, message)
}

/**
 * Normalize an entry path for duplicate detection: strip a leading `./`,
 * convert backslashes, collapse repeated slashes, and drop a trailing slash.
 * `package/a.js`, `./package/a.js` and `package//a.js` are the same file to an
 * extractor, so they must be the same key here.
 */
export function normalizeEntryName(name: string): string {
  return name
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/$/, '')
}

/**
 * Inflate a gzip stream, refusing to buffer more than `maxTotalBytes`. Bounding
 * the OUTPUT (rather than trusting the compressed size) is what stops a gzip
 * bomb: a few hundred KB can inflate to gigabytes and OOM the runner.
 */
export async function gunzipBounded(
  gzipped: Uint8Array,
  maxTotalBytes: number,
): Promise<Uint8Array> {
  // Cast: the Worker and Node lib types disagree on the BodyInit union, and
  // this module is compiled under both (tsconfig.json and tsconfig.action.json).
  const stream = new Response(gzipped as unknown as ReadableStream).body
  if (!stream) reject('Tarball is empty')
  const reader = stream.pipeThrough(new DecompressionStream('gzip')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxTotalBytes) {
        // Cancel so the decompressor stops doing work for a rejected archive.
        await reader.cancel().catch(() => {})
        reject(`Tarball inflates past the ${maxTotalBytes} byte limit`)
      }
      chunks.push(value)
    }
  } catch (err) {
    if (err instanceof HttpError) throw err
    reject(`Tarball is not valid gzip: ${err}`)
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

/**
 * Apply the entry-level policy. Runs over already-inflated entries, so the
 * total-size bound belongs to {@link gunzipBounded}, not here.
 */
export function assertCanonicalEntries(
  files: ParsedTarFileItem[],
  policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
): void {
  if (files.length === 0) reject('Tarball contains no entries')
  if (files.length > policy.maxEntries) {
    reject(`Tarball has ${files.length} entries, over the ${policy.maxEntries} limit`)
  }

  const seen = new Set<string>()
  let manifests = 0

  for (const file of files) {
    // Traversal and absolute paths. Shared with the repack path so both agree.
    assertSafeTarballPath(file.name)
    const normalized = normalizeEntryName(file.name)
    if (/^[a-zA-Z]:/.test(normalized)) {
      reject(`Unsafe drive-letter path in tarball: ${file.name}`)
    }
    if (normalized === '' || normalized === '.') {
      reject(`Empty entry name in tarball`)
    }

    // Symlinks, hardlinks, devices and FIFOs have no place in an npm tarball,
    // and each is a way to make extraction touch something outside the package.
    // `undefined` means nanotar could not classify the header.
    if (!file.type || !ALLOWED_ENTRY_TYPES.has(file.type)) {
      reject(`Unsupported tar entry type ${file.type ?? 'unknown'}: ${file.name}`)
    }

    if (seen.has(normalized)) {
      reject(`Duplicate entry in tarball: ${normalized}`)
    }
    seen.add(normalized)

    if (PACKAGE_JSON_NAMES.has(file.name) || normalized === 'package/package.json') {
      manifests++
    }

    if (!isUnderPackageRoot(file.name)) {
      reject(`Entry outside the package/ root: ${file.name}`)
    }

    if ((file.size ?? 0) > policy.maxFileBytes) {
      reject(`Entry ${file.name} is ${file.size} bytes, over the per-file limit`)
    }
  }

  // Exactly one, so no extractor can disagree with the validator about which
  // manifest is authoritative.
  if (manifests === 0) reject('Tarball is missing package/package.json')
  if (manifests > 1) reject('Tarball contains more than one package/package.json')
}

/**
 * Validate an untrusted gzipped package tarball end to end and return its
 * entries. Callers repack from the returned entries (or hand the original
 * bytes to `buildPreviewTarball`, which repacks) so the published artifact is
 * always one we emitted.
 */
export async function validateArchive(
  gzippedTarball: Uint8Array,
  policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
): Promise<ParsedTarFileItem[]> {
  const inflated = await gunzipBounded(gzippedTarball, policy.maxTotalBytes)
  let files: ParsedTarFileItem[]
  try {
    files = parseTar(inflated)
  } catch (err) {
    reject(`Tarball is not a readable tar archive: ${err}`)
  }
  assertCanonicalEntries(files, policy)
  return files
}
