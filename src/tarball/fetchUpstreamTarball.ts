import { HttpError } from '../httpError'

async function fetchUpstream(
  url: string,
  maxBytes: number,
): Promise<{ body: ReadableStream<Uint8Array>; declaredLength: number | null }> {
  const res = await fetch(url, {
    headers: {
      accept: 'application/octet-stream',
      'user-agent': 'pkg-pr-registry-bridge',
    },
    redirect: 'follow',
  })

  if (res.status === 404) {
    throw new HttpError(404, 'Upstream preview build not found')
  }
  if (!res.ok || !res.body) {
    throw new HttpError(502, `Failed to fetch upstream tarball (${res.status})`)
  }

  // Only a well-formed non-negative integer counts as declared: anything else
  // (absent, blank, fractional, non-numeric) is treated as unknown, rather
  // than coerced by `Number(...)` (which turns `''` into `0`, not `NaN`).
  const header = res.headers.get('content-length')
  const declared = header !== null && /^\d+$/.test(header) ? Number(header) : null
  if (declared !== null && declared > maxBytes) {
    throw new HttpError(413, 'Upstream tarball exceeds the maximum size')
  }
  return { body: res.body, declaredLength: declared }
}

/** Cancel the reader and reject for exceeding `maxBytes`. Never returns. */
async function rejectOversized(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<never> {
  await reader.cancel()
  throw new HttpError(413, 'Upstream tarball exceeds the maximum size')
}

/**
 * Download an upstream pkg.pr.new tarball into memory, enforcing a maximum size
 * while streaming so a malicious or oversized upstream cannot exhaust the
 * Worker.
 */
export async function fetchUpstreamTarball(
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const { body, declaredLength } = await fetchUpstream(url, maxBytes)
  const reader = body.getReader()

  // `Content-Length` is a sizing HINT, never a hard cap: the limit actually
  // enforced is always `maxBytes`. Pre-size the buffer to it so a correctly
  // reported download (the common case) streams straight into one buffer with
  // no extra copy at the end; an upstream that under-reports its own size (a
  // re-chunking proxy, an off-by-a-few-bytes header) just grows the buffer
  // rather than failing with a spurious "too large". Growth here is expected
  // to be a small correction to a mostly-right guess, so doubling from that
  // guess (rather than the unbounded doubling-from-nothing below) doesn't
  // meaningfully overshoot the actual size.
  if (declaredLength !== null) {
    let out = new Uint8Array(declaredLength)
    let offset = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const end = offset + value.byteLength
      if (end > maxBytes) {
        return rejectOversized(reader)
      }
      if (end > out.length) {
        const grown = new Uint8Array(Math.min(maxBytes, Math.max(out.length * 2, end)))
        grown.set(out.subarray(0, offset))
        out = grown
      }
      out.set(value, offset)
      offset = end
    }
    return offset === out.length ? out : out.slice(0, offset)
  }

  // No usable size hint at all: collect chunks as-is (no reallocation while
  // streaming) and copy them into one exactly-sized buffer at the end, so
  // peak memory tracks the actual body size instead of a doubling sequence
  // that can land far above it (e.g. an unknown-length body just over half of
  // `maxBytes` would otherwise grow all the way to the `maxBytes` cap before
  // being sliced back down).
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      return rejectOversized(reader)
    }
    chunks.push(value)
  }

  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}
