import {
  createTar,
  parseTarGzip,
  type ParsedTarFileItem,
  type TarFileInput,
} from 'nanotar'
import { HttpError } from '../httpError'
import { rewritePackageJson } from './rewritePackageJson'
import { computeDigests } from './digests'
import {
  assertSafeTarballPath,
  isPackageManifest,
  isUnderPackageRoot,
  normalizeEntryName,
} from '../security/validateTarballPath'

/** Two 512-byte blocks: the size of a tar end-of-archive marker. */
const TAR_MARKER_BYTES = 1024

/**
 * Guarantee the archive ends with the tar end-of-archive marker (two 512-byte
 * all-zero blocks). nanotar pads the archive up to a full 10240-byte record and
 * relies on that zero slack to form the marker, but emits NO slack when the
 * packed size is already an exact multiple of 10240 (and only a single zero
 * block when it is 512 short of one). Lenient readers (BSD/GNU tar) tolerate a
 * missing/short marker, but pnpm's strict extractor then reads a header past
 * EOF and fails with ERR_PNPM_TARBALL_EXTRACT. Append a clean marker whenever
 * the last 1024 bytes are not already all zero; a no-op for normal archives.
 */
function withEndOfArchiveMarker(tar: Uint8Array): Uint8Array {
  const hasMarker =
    tar.length >= TAR_MARKER_BYTES &&
    tar.subarray(tar.length - TAR_MARKER_BYTES).every((b) => b === 0)
  if (hasMarker) return tar
  const out = new Uint8Array(tar.length + TAR_MARKER_BYTES)
  out.set(tar, 0)
  return out
}

/** Gzip a byte buffer using the runtime's CompressionStream (deterministic). */
async function gzip(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(data).body!.pipeThrough(
    new CompressionStream('gzip'),
  )
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/**
 * Fixed mtime for every repacked entry, in epoch milliseconds
 * (1985-10-26T08:15:00Z).
 *
 * Not an arbitrary choice: this is exactly what node-tar's `portable` mode
 * stamps, so it is already the mtime on every entry `pnpm pack` produces, and
 * repacking now preserves that date instead of inventing one.
 *
 * Setting it explicitly also fixes a latent bug. nanotar's parser returns
 * mtime in SECONDS while its writer expects MILLISECONDS and divides by 1000,
 * so passing a parsed `attrs` straight back to the writer divided by 1000 a
 * second time: 1985-10-26 was written out as 1970-01-06. Every preview tarball
 * published before this carries that mangled date. Anything else that
 * round-trips nanotar attrs needs the same care.
 *
 * The payoff is that a rebuild is deterministic: identical content produces
 * identical bytes, so republishing a commit lands on the SAME
 * content-addressed key instead of accumulating one object per run. The gzip
 * layer cooperates, because `CompressionStream` writes a zeroed MTIME into the
 * gzip header rather than the current time.
 *
 * Because the mtime changes, republishing a commit that was published before
 * this lands on a new CAS key. That is harmless (the packument advertises the
 * new shasum, and the old object expires with its ref) but it is why an
 * already-published version will not hash to its stored value.
 */
const CANONICAL_MTIME_MS = 499_162_500_000

/**
 * Normalize an entry's metadata on repack (RFC 0002 SR-6).
 *
 * The mode comes from the tar header, which is attacker-controlled for any
 * archive the bridge did not produce, and it was previously passed straight
 * through. Setuid, setgid and sticky bits therefore survived into the
 * published tarball. npm and pnpm apply their own modes on extract, so this is
 * a small exposure, but "the bytes we publish are ones we constructed" is only
 * true if the metadata is ours too.
 *
 * Collapsing to 755/644 preserves the one bit that carries meaning in an npm
 * package (is this file executable, which `bin` entries need) and discards
 * everything else. Ownership and mtime are flattened for the same reason: they
 * describe the packing machine, never anything a consumer should honour.
 *
 * Every field here is fixed or derived from one bit of the input, so the
 * rebuild is deterministic. `pnpm pack` already emits these same values
 * (node-tar's `portable` mode: 755/644, uid/gid 0, and CANONICAL_MTIME_MS), so
 * for a well-behaved source this normalizes to what was already there.
 */
function canonicalAttrs(file: ParsedTarFileItem): TarFileInput['attrs'] {
  const parsed = Number.parseInt(file.attrs?.mode ?? '', 8)
  const executable = Number.isFinite(parsed) && (parsed & 0o111) !== 0
  return {
    mode: file.type === 'directory' || executable ? '755' : '644',
    uid: 0,
    gid: 0,
    user: '',
    group: '',
    mtime: CANONICAL_MTIME_MS,
  }
}

const textEncoder = new TextEncoder()

/**
 * The ustar name field. nanotar's writer encodes the name into exactly these
 * 100 bytes and emits neither a ustar `prefix` nor a PAX/GNU long-name record,
 * so a longer path is silently truncated: `package/<100 a's>/index.js` comes
 * back as a 96-byte name, and a sibling sharing that prefix comes back as the
 * SAME name. Refusing is the only honest option while the writer cannot
 * represent them; a truncated path means a broken published package, and a
 * collision means two files became one.
 *
 * Enforced here rather than only in the archive policy so it covers `publish`
 * mode too, where the input is trusted `pnpm pack` output that never went
 * through validation.
 */
const MAX_ENTRY_NAME_BYTES = 100

/** Serialize a rewritten package.json to the bytes written into the tarball. */
export function encodePackageJson(pkg: Record<string, any>): Uint8Array {
  return textEncoder.encode(`${JSON.stringify(pkg, null, 2)}\n`)
}

/** The cacheable artifacts for a preview version (everything but the bytes). */
export interface PreviewMeta {
  /** The rewritten package.json, reused to build packument version metadata. */
  packageJson: Record<string, any>
  /** SHA-1 hex of the generated tarball, for `dist.shasum`. */
  shasum: string
  /** SHA-512 SRI of the generated tarball, for `dist.integrity`. */
  integrity: string
  /**
   * ISO-8601 timestamp stamped server-side when this build was published, used
   * as the version's `time` (release date) in the packument. Optional for
   * back-compat with metas stored before this field existed.
   */
  publishedAt?: string
}

export interface PreviewBuild extends PreviewMeta {
  /** The gzipped tarball bytes to serve. */
  tarball: Uint8Array
}

/**
 * Parse the gzipped tarball and locate `package/package.json`, returning all
 * entries, the package.json entry, and its parsed contents.
 */
async function parsePackageJson(gzippedTarball: Uint8Array): Promise<{
  files: ParsedTarFileItem[]
  pkgEntry: ParsedTarFileItem
  pkg: Record<string, any>
}> {
  const files = await parseTarGzip(gzippedTarball)
  const pkgEntry = files.find(
    (f) => isPackageManifest(normalizeEntryName(f.name)) && f.data,
  )
  if (!pkgEntry || !pkgEntry.data) {
    throw new HttpError(422, 'Upstream tarball is missing package/package.json')
  }
  try {
    return { files, pkgEntry, pkg: JSON.parse(new TextDecoder().decode(pkgEntry.data)) }
  } catch {
    throw new HttpError(422, 'Invalid package/package.json in upstream tarball')
  }
}

/**
 * Rewrite a packed package tarball into a preview release:
 *   1. parse gzip + tar,
 *   2. find and rewrite `package/package.json`,
 *   3. repack only entries under the `package/` root, normalizing metadata,
 *   4. re-gzip.
 *
 * Only `package/package.json` changes; every other entry's CONTENT passes
 * through byte for byte. Its metadata does not: modes collapse to 755/644 and
 * ownership is flattened (see canonicalAttrs), which keeps executables
 * executable while discarding attacker-controlled bits from an untrusted
 * archive.
 */
export async function buildPreviewTarball(
  gzippedTarball: Uint8Array,
  packageName: string,
  version: string,
  batch: ReadonlySet<string>,
): Promise<PreviewBuild> {
  const { files, pkgEntry, pkg } = await parsePackageJson(gzippedTarball)

  const rewritten = rewritePackageJson(pkg, packageName, version, batch)
  const rewrittenBytes = encodePackageJson(rewritten)

  const out: TarFileInput[] = []
  for (const file of files) {
    const normalized = normalizeEntryName(file.name)
    assertSafeTarballPath(normalized)
    if (!isUnderPackageRoot(normalized)) continue
    if (textEncoder.encode(file.name).length > MAX_ENTRY_NAME_BYTES) {
      throw new HttpError(
        422,
        `Entry name exceeds the ${MAX_ENTRY_NAME_BYTES}-byte tar name field: ${file.name}`,
      )
    }
    out.push({
      name: file.name,
      data: file === pkgEntry ? rewrittenBytes : file.data,
      attrs: canonicalAttrs(file),
    })
  }

  // Build the raw tar, ensure it carries the end-of-archive marker (nanotar
  // can omit it, see withEndOfArchiveMarker), then gzip. Integrity/shasum are
  // computed over these final bytes, so they always match what is served.
  const tarball = await gzip(withEndOfArchiveMarker(createTar(out)))
  const { shasum, integrity } = await computeDigests(tarball)
  return { tarball, packageJson: rewritten, shasum, integrity }
}
