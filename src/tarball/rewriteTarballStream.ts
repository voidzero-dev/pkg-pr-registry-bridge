/**
 * Streaming tar rewriter.
 *
 * Replaces the bytes of a single named entry (the rewritten `package.json`)
 * inside a gzipped tar, fixing that entry's header (size + checksum), and passes
 * every other entry through byte-for-byte. Runs as a Web Streams pipeline
 * (`DecompressionStream` -> tar transform -> `CompressionStream`) so the
 * decompressed payload is never held whole in memory.
 *
 * This is what lets the platform-binary tarballs work: their native `.node`
 * payload decompresses to tens of MB, and re-tarring + re-gzipping it as whole
 * buffers exceeds the Worker memory/CPU budget (Cloudflare error 1102). Only the
 * tiny `package.json` is buffered; the large binary streams straight through.
 */

import { HttpError } from '../httpError'

// Tar/stream bytes can be backed by any ArrayBuffer-like buffer (stream chunks,
// subarrays, fresh allocations); use one alias so they compose without friction.
type Bytes = Uint8Array<ArrayBufferLike>

const BLOCK = 512
const NAME_LEN = 100
const SIZE_OFF = 124
const SIZE_LEN = 12
const CHKSUM_OFF = 148
const CHKSUM_LEN = 8
const MAGIC_OFF = 257
const PREFIX_OFF = 345
const PREFIX_LEN = 155

function isZeroBlock(block: Bytes): boolean {
  for (let i = 0; i < block.length; i++) if (block[i] !== 0) return false
  return true
}

function readCStr(header: Bytes, off: number, len: number): string {
  let end = 0
  while (end < len && header[off + end] !== 0) end++
  return new TextDecoder().decode(header.subarray(off, off + end))
}

function readName(header: Bytes): string {
  const name = readCStr(header, 0, NAME_LEN)
  // USTAR may split a long path across the 155-byte prefix field; include it so
  // the name we match/validate is the full path (defeats a prefix-split guard
  // bypass). magic 'ustar' at offset 257.
  const isUstar =
    header[MAGIC_OFF] === 0x75 &&
    header[MAGIC_OFF + 1] === 0x73 &&
    header[MAGIC_OFF + 2] === 0x74 &&
    header[MAGIC_OFF + 3] === 0x61 &&
    header[MAGIC_OFF + 4] === 0x72
  if (isUstar) {
    const prefix = readCStr(header, PREFIX_OFF, PREFIX_LEN)
    if (prefix) return `${prefix}/${name}`
  }
  return name
}

function readSize(header: Bytes): number {
  // Octal ASCII, space/NUL padded. npm tarballs never use the GNU base-256
  // encoding (only for entries >=8GB); reject it rather than misparse and
  // desync the stream.
  if (header[SIZE_OFF] & 0x80) {
    throw new HttpError(422, 'Unsupported base-256 size field in tarball')
  }
  let value = 0
  for (let i = SIZE_OFF; i < SIZE_OFF + SIZE_LEN; i++) {
    const c = header[i]
    if (c === 0 || c === 0x20) continue
    value = value * 8 + (c - 0x30)
  }
  return value
}

function paddedLen(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK
}

/** Rebuild a header for the replaced entry: new size + recomputed checksum. */
function rebuildHeader(original: Bytes, newSize: number): Bytes {
  const header = new Uint8Array(BLOCK)
  header.set(original)

  // size: 11 octal digits + NUL.
  const octal = newSize.toString(8).padStart(SIZE_LEN - 1, '0')
  for (let i = 0; i < SIZE_LEN - 1; i++) {
    header[SIZE_OFF + i] = octal.charCodeAt(i)
  }
  header[SIZE_OFF + SIZE_LEN - 1] = 0

  // checksum is computed with the checksum field filled with spaces.
  for (let i = 0; i < CHKSUM_LEN; i++) header[CHKSUM_OFF + i] = 0x20
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += header[i]

  // write as 6 octal digits + NUL + space.
  const chk = sum.toString(8).padStart(6, '0')
  for (let i = 0; i < 6; i++) header[CHKSUM_OFF + i] = chk.charCodeAt(i)
  header[CHKSUM_OFF + 6] = 0
  header[CHKSUM_OFF + 7] = 0x20
  return header
}

function concat(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const out = new Uint8Array(a.length + b.length)
  out.set(a)
  out.set(b, a.length)
  return out
}

/**
 * A TransformStream over the *decompressed* tar byte stream. `replaceNames` is
 * the set of entry names to replace; `replaceWith` maps the original entry data
 * to its replacement bytes; `validateName` (optional) is called for every entry
 * and may throw to abort (e.g. path-traversal guard).
 */
function tarRewriteTransform(
  replaceNames: Set<string>,
  replaceWith: (data: Uint8Array) => Uint8Array,
  validateName?: (name: string) => void,
): TransformStream<Bytes, Bytes> {
  let buf: Bytes = new Uint8Array(0)
  // 'header' -> at an entry boundary; 'copy'/'skip' -> inside entry data;
  // 'trailer' -> hit the end-of-archive zero blocks, pass everything through.
  let state: 'header' | 'copy' | 'trailer' = 'header'
  let remaining = 0

  return new TransformStream<Bytes, Bytes>({
    transform(chunk, controller) {
      buf = concat(buf, chunk)

      for (;;) {
        if (state === 'trailer') {
          if (buf.length) controller.enqueue(buf)
          buf = new Uint8Array(0)
          return
        }

        if (state === 'copy') {
          if (remaining === 0) {
            state = 'header'
            continue
          }
          if (buf.length === 0) return
          const take = Math.min(remaining, buf.length)
          controller.enqueue(buf.subarray(0, take))
          buf = buf.subarray(take)
          remaining -= take
          continue
        }

        // state === 'header'
        if (buf.length < BLOCK) return
        const header = buf.subarray(0, BLOCK)

        if (isZeroBlock(header)) {
          // End-of-archive; stream the rest (trailing zero blocks) unchanged.
          state = 'trailer'
          continue
        }

        const name = readName(header)
        validateName?.(name)
        const size = readSize(header)
        const padded = paddedLen(size)

        if (replaceNames.has(name)) {
          // Need the whole (small) entry to transform it.
          if (buf.length < BLOCK + padded) return
          const data = buf.subarray(BLOCK, BLOCK + size)
          const replacement = replaceWith(data)
          controller.enqueue(rebuildHeader(header, replacement.length))
          controller.enqueue(replacement)
          const pad = (BLOCK - (replacement.length % BLOCK)) % BLOCK
          if (pad) controller.enqueue(new Uint8Array(pad))
          buf = buf.subarray(BLOCK + padded)
          continue
        }

        // Copy entry: emit the header, stream its data as it arrives.
        controller.enqueue(header.slice())
        buf = buf.subarray(BLOCK)
        remaining = padded
        state = 'copy'
      }
    },
    flush(controller) {
      if (buf.length) controller.enqueue(buf)
    },
  })
}

/**
 * Stream-rewrite a gzipped tar: replace the named entry's bytes and re-gzip,
 * passing all other bytes through. Returns the gzipped output stream.
 */
export function rewriteTarballEntryStream(
  gzipped: ReadableStream<Uint8Array>,
  replaceNames: Set<string>,
  replaceWith: (data: Uint8Array) => Uint8Array,
  validateName?: (name: string) => void,
): ReadableStream<Uint8Array> {
  return gzipped
    .pipeThrough(new DecompressionStream('gzip'))
    .pipeThrough(tarRewriteTransform(replaceNames, replaceWith, validateName))
    .pipeThrough(new CompressionStream('gzip'))
}
