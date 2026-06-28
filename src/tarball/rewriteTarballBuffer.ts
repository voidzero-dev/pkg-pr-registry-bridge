/**
 * In-place tar rewriting and stored-gzip emission over a decompressed buffer.
 *
 * The platform-binary build decompresses the upstream ONCE into a single buffer
 * (within the Worker budget, the packument path already does this via
 * buildMetaLight), rewrites `package/package.json` in place, then re-emits the
 * buffer as gzip "stored" blocks. Because the buffer is fully in memory while it
 * is framed and uploaded, no decompressor is running during the slow R2 part
 * uploads, so nothing buffers ahead, which is what made the previous streaming
 * build spike past the 128MB limit (Cloudflare 1102) under upload backpressure.
 */

import { HttpError } from '../httpError'

const BLOCK = 512
const NAME_LEN = 100
const SIZE_OFF = 124
const SIZE_LEN = 12
const CHKSUM_OFF = 148
const CHKSUM_LEN = 8
const MAGIC_OFF = 257
const PREFIX_OFF = 345
const PREFIX_LEN = 155

const textDecoder = new TextDecoder()

function isZeroBlock(tar: Uint8Array, off: number): boolean {
  for (let i = off; i < off + BLOCK; i++) if (tar[i] !== 0) return false
  return true
}

function readCStr(tar: Uint8Array, off: number, len: number): string {
  let end = 0
  while (end < len && tar[off + end] !== 0) end++
  return textDecoder.decode(tar.subarray(off, off + end))
}

function readName(tar: Uint8Array, off: number): string {
  const name = readCStr(tar, off, NAME_LEN)
  const isUstar =
    tar[off + MAGIC_OFF] === 0x75 &&
    tar[off + MAGIC_OFF + 1] === 0x73 &&
    tar[off + MAGIC_OFF + 2] === 0x74 &&
    tar[off + MAGIC_OFF + 3] === 0x61 &&
    tar[off + MAGIC_OFF + 4] === 0x72
  if (isUstar) {
    const prefix = readCStr(tar, off + PREFIX_OFF, PREFIX_LEN)
    if (prefix) return `${prefix}/${name}`
  }
  return name
}

function readSize(tar: Uint8Array, off: number): number {
  if (tar[off + SIZE_OFF] & 0x80) {
    throw new HttpError(422, 'Unsupported base-256 size field in tarball')
  }
  let value = 0
  for (let i = off + SIZE_OFF; i < off + SIZE_OFF + SIZE_LEN; i++) {
    const c = tar[i]
    if (c === 0 || c === 0x20) continue
    value = value * 8 + (c - 0x30)
  }
  return value
}

/** Rewrite the header in place for a new (smaller-or-equal) entry size. */
function writeHeader(tar: Uint8Array, off: number, newSize: number): void {
  const octal = newSize.toString(8).padStart(SIZE_LEN - 1, '0')
  for (let i = 0; i < SIZE_LEN - 1; i++) {
    tar[off + SIZE_OFF + i] = octal.charCodeAt(i)
  }
  tar[off + SIZE_OFF + SIZE_LEN - 1] = 0

  for (let i = 0; i < CHKSUM_LEN; i++) tar[off + CHKSUM_OFF + i] = 0x20
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += tar[off + i]
  const chk = sum.toString(8).padStart(6, '0')
  for (let i = 0; i < 6; i++) tar[off + CHKSUM_OFF + i] = chk.charCodeAt(i)
  tar[off + CHKSUM_OFF + 6] = 0
  tar[off + CHKSUM_OFF + 7] = 0x20
}

/**
 * Overwrite each `replaceNames` entry in `tar` with `replaceWith(originalData)`,
 * in place, preserving the tar layout (the replacement is zero-padded to the
 * entry's existing block allocation, so the large binary after it never moves).
 * Throws if a replacement does not fit (true only for an unexpectedly large
 * package.json) or if an entry name fails `validateName`.
 */
export function rewriteTarEntryInPlace(
  tar: Uint8Array,
  replaceNames: Set<string>,
  replaceWith: (data: Uint8Array) => Uint8Array,
  validateName?: (name: string) => void,
): void {
  let off = 0
  while (off + BLOCK <= tar.length) {
    if (isZeroBlock(tar, off)) break // end-of-archive
    const name = readName(tar, off)
    validateName?.(name)
    const size = readSize(tar, off)
    const padded = Math.ceil(size / BLOCK) * BLOCK

    if (replaceNames.has(name)) {
      const replacement = replaceWith(tar.subarray(off + BLOCK, off + BLOCK + size))
      if (replacement.length > padded) {
        throw new HttpError(
          500,
          'Rewritten package.json does not fit the tarball entry',
        )
      }
      tar.set(replacement, off + BLOCK)
      tar.fill(0, off + BLOCK + replacement.length, off + BLOCK + padded)
      writeHeader(tar, off, replacement.length)
    }
    off += BLOCK + padded
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/**
 * Emit `tar` as a valid gzip using "stored" (uncompressed) deflate blocks,
 * calling `emit` for each output chunk. Re-emitting stored blocks is near-zero
 * CPU and emits views into the (in-memory) input, so the only copies are made by
 * the consumer (e.g. assembling R2 multipart parts). `emit` is awaited so the
 * consumer can apply backpressure.
 */
export async function emitStoredGzip(
  tar: Uint8Array,
  emit: (chunk: Uint8Array) => Promise<void>,
): Promise<void> {
  // gzip header: magic, deflate method, no flags, no mtime, OS unknown.
  await emit(new Uint8Array([0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff]))

  let crc = 0xffffffff
  for (let off = 0; off < tar.length; off += 65535) {
    const n = Math.min(65535, tar.length - off)
    const seg = tar.subarray(off, off + n)
    for (let i = 0; i < n; i++) {
      crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ seg[i]) & 0xff]
    }
    // Stored block header: BFINAL/BTYPE byte (0) + LEN + ~LEN, both LE.
    await emit(new Uint8Array([0, n & 0xff, (n >> 8) & 0xff, ~n & 0xff, (~n >> 8) & 0xff]))
    await emit(seg)
  }

  // Final empty stored block, then CRC32 + ISIZE (both little-endian).
  await emit(new Uint8Array([1, 0, 0, 0xff, 0xff]))
  const trailer = new Uint8Array(8)
  const dv = new DataView(trailer.buffer)
  dv.setUint32(0, (crc ^ 0xffffffff) >>> 0, true)
  dv.setUint32(4, tar.length >>> 0, true)
  await emit(trailer)
}
