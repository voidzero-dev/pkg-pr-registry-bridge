/**
 * In-place tar rewriter over a decompressed buffer.
 *
 * Rewrites a single named entry (the `package.json`) inside an already
 * decompressed tar, WITHOUT moving any other bytes: the replacement is written
 * into the entry's existing 512-byte block allocation (padded with zeros) and
 * the header's size + checksum are fixed. This keeps the whole tar layout
 * identical, so the large native binary that follows never has to be copied.
 *
 * Buffering the decompressed tar once is within the Worker budget (the packument
 * path already does it via buildMetaLight); the win here is avoiding a SECOND
 * full copy (a re-tar), which is what pushes a platform-binary build over the
 * 128MB limit.
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
 * Find `replaceNames` entries in `tar` and overwrite each with
 * `replaceWith(originalData)`, in place. Throws if a replacement does not fit
 * the entry's existing block allocation (true for the tiny package.json) or if
 * an entry name fails `validateName`.
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
