/**
 * Canonical archive policy for tarballs the bridge did not produce
 * (RFC 0002 SR-6).
 *
 * The trusted publishing workflow reads tarballs out of an artifact built by an
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
import {
  assertSafeTarballPath,
  isPackageManifest,
  isUnderPackageRoot,
  normalizeEntryName,
} from '../security/validateTarballPath'

export { normalizeEntryName }

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

const TAR_BLOCK = 512

/**
 * Type flags for metadata records that `parseTar` consumes and never returns:
 * PAX extended headers (`x`, `g`) and the GNU long-name records (`L`, `K`,
 * `N`). Real npm tarballs do carry these, because a path over 100 bytes cannot
 * fit the ustar name field, so they cannot simply be rejected.
 */
const EXTENSION_TYPE_FLAGS = new Set(['x', 'g', 'L', 'K', 'N'])

/**
 * Cap on one metadata record. These hold a path or a few key/value pairs, so
 * kilobytes is already generous; the point is that a record claiming hundreds
 * of megabytes is not a path.
 */
const MAX_EXTENSION_RECORD_BYTES = 64 * 1024

/**
 * The ustar name field. Longer paths need a PAX or GNU long-name record, which
 * nanotar can READ but not WRITE, so they cannot survive the canonical rebuild.
 */
export const MAX_ENTRY_NAME_BYTES = 100

/**
 * Read a tar octal numeric field the SAME way nanotar's `_readNumber` does.
 *
 * This must not merely be correct, it must agree with the parser, or the two
 * disagree about where a record ends and the scan below stops bounding things
 * the parser still processes. An earlier version stopped at the first space,
 * which made ` 2000000000\0` read as 0 here (padding-terminated) and as 256MiB
 * in nanotar (`parseInt` skips leading whitespace). The scanner then advanced
 * one block into an attacker-controlled payload, hit a zero byte, and treated
 * it as end-of-archive, leaving the rest of the archive unbounded.
 *
 * So: build the whole field and `parseInt` it, exactly as nanotar does, and
 * separately reject any field that is not octal digits with space/NUL padding
 * (which `parseInt` would silently accept a prefix of).
 */
function readOctalField(tar: Uint8Array, offset: number, length: number): number {
  // High bit set means base-256, used only for sizes past 8GB. Nothing
  // legitimate here needs it, and parsing it would just widen the surface.
  if (tar[offset] & 0x80) reject('Tarball uses base-256 size fields')
  let text = ''
  for (let i = offset; i < offset + length; i++) {
    text += String.fromCharCode(tar[i])
  }
  if (!/^[\s\0]*[0-7]*[\s\0]*$/.test(text)) {
    reject('Tarball has a malformed size field')
  }
  const value = Number.parseInt(text, 8)
  if (!Number.isSafeInteger(value) || value < 0) {
    reject('Tarball has an unreadable record size')
  }
  return value
}

/**
 * Walk the raw 512-byte records and bound every one, including the metadata
 * records `parseTar` swallows.
 *
 * This runs BEFORE `parseTar` because that function handles `extendedHeader`,
 * `globalExtendedHeader` and the GNU long-name types with `continue`: it
 * decodes their payload into strings and drops them from its returned `files`.
 * So the entry-count, per-file and entry-type checks below never observe them,
 * and an archive could carry unlimited metadata records, or one claiming
 * hundreds of megabytes, and slip straight past the entry-level policy into
 * large string allocations inside the parser.
 */
export function assertBoundedTarRecords(
  tar: Uint8Array,
  policy: ArchivePolicy = DEFAULT_ARCHIVE_POLICY,
): void {
  let offset = 0
  let records = 0

  while (offset + TAR_BLOCK <= tar.length) {
    // An all-zero name field marks the end-of-archive marker.
    if (tar[offset] === 0) break

    records++
    if (records > policy.maxEntries) {
      reject(`Tarball has over ${policy.maxEntries} records`)
    }

    const size = readOctalField(tar, offset + 124, 12)

    const typeFlag = String.fromCharCode(tar[offset + 156] || 0x30)
    const isMetadata = EXTENSION_TYPE_FLAGS.has(typeFlag)
    const limit = isMetadata ? MAX_EXTENSION_RECORD_BYTES : policy.maxFileBytes
    if (size > limit) {
      reject(
        `Tarball ${isMetadata ? 'metadata ' : ''}record is ${size} bytes, ` +
          `over the ${limit} byte limit`,
      )
    }

    const next = offset + TAR_BLOCK + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK
    // A size that wraps or fails to advance would loop forever.
    if (next <= offset) reject('Tarball has a malformed record')
    offset = next
  }
}

function reject(message: string): never {
  throw new HttpError(422, message)
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
    reject(`Tarball is not valid gzip: ${String(err)}`)
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
    // Normalize ONCE, then every check below reads the same spelling. Comparing
    // different spellings of one path is the disagreement this module exists to
    // remove, so it must not reintroduce it internally.
    const normalized = normalizeEntryName(file.name)
    assertSafeTarballPath(normalized)
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

    // nanotar's writer puts the name in the 100-byte ustar field and emits
    // neither a prefix nor a long-name record, so a longer path is silently
    // TRUNCATED on rebuild, and two paths sharing their first 100 bytes collapse
    // into one entry, defeating the duplicate rule above. Refuse what the
    // canonical writer cannot represent rather than publish a mangled archive.
    if (new TextEncoder().encode(normalized).length > MAX_ENTRY_NAME_BYTES) {
      reject(`Entry name exceeds ${MAX_ENTRY_NAME_BYTES} bytes: ${normalized}`)
    }

    if (isPackageManifest(normalized)) manifests++

    if (!isUnderPackageRoot(normalized)) {
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
  // Bound the raw records first: parseTar consumes metadata records without
  // returning them, so anything checked after it runs cannot see them.
  assertBoundedTarRecords(inflated, policy)
  let files: ParsedTarFileItem[]
  try {
    files = parseTar(inflated)
  } catch (err) {
    reject(`Tarball is not a readable tar archive: ${String(err)}`)
  }
  assertCanonicalEntries(files, policy)
  return files
}
