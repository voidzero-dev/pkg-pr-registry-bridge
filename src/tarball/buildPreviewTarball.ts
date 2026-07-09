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
  isUnderPackageRoot,
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

export const PACKAGE_JSON_NAMES = new Set([
  'package/package.json',
  './package/package.json',
])

const textEncoder = new TextEncoder()

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
 * Parse the upstream gzipped tarball and locate `package/package.json`,
 * returning all entries, the package.json entry, and its parsed contents.
 * Shared by the meta-only and full-rebuild paths below.
 */
async function parsePackageJson(gzippedTarball: Uint8Array): Promise<{
  files: ParsedTarFileItem[]
  pkgEntry: ParsedTarFileItem
  pkg: Record<string, any>
}> {
  const files = await parseTarGzip(gzippedTarball)
  const pkgEntry = files.find((f) => PACKAGE_JSON_NAMES.has(f.name) && f.data)
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
 *   3. repack only entries under the `package/` root, preserving file modes,
 *   4. re-gzip.
 *
 * Only `package/package.json` changes; all other entries pass through byte for
 * byte (with their original attrs/mode), which keeps executables executable.
 */
export async function buildPreviewTarball(
  gzippedTarball: Uint8Array,
  packageName: string,
  version: string,
  batch?: ReadonlySet<string>,
): Promise<PreviewBuild> {
  const { files, pkgEntry, pkg } = await parsePackageJson(gzippedTarball)

  const rewritten = rewritePackageJson(pkg, packageName, version, batch)
  const rewrittenBytes = encodePackageJson(rewritten)

  const out: TarFileInput[] = []
  for (const file of files) {
    assertSafeTarballPath(file.name)
    if (!isUnderPackageRoot(file.name)) continue
    out.push({
      name: file.name,
      data: file === pkgEntry ? rewrittenBytes : file.data,
      attrs: file.attrs,
    })
  }

  // Build the raw tar, ensure it carries the end-of-archive marker (nanotar
  // can omit it, see withEndOfArchiveMarker), then gzip. Integrity/shasum are
  // computed over these final bytes, so they always match what is served.
  const tarball = await gzip(withEndOfArchiveMarker(createTar(out)))
  const { shasum, integrity } = await computeDigests(tarball)
  return { tarball, packageJson: rewritten, shasum, integrity }
}
