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

  const header = res.headers.get('content-length')
  const declared = header !== null ? Number(header) : NaN
  const valid = Number.isFinite(declared) && declared >= 0
  if (valid && declared > maxBytes) {
    throw new HttpError(413, 'Upstream tarball exceeds the maximum size')
  }
  return { body: res.body, declaredLength: valid ? declared : null }
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

  // `Content-Length` is already known (and within bounds) here, so stream
  // straight into one pre-sized buffer instead of collecting per-chunk arrays
  // and copying them all into a second, final buffer (halves peak memory for
  // this, the common, case).
  if (declaredLength !== null) {
    const out = new Uint8Array(declaredLength)
    let offset = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (offset + value.byteLength > declaredLength) {
        return rejectOversized(reader)
      }
      out.set(value, offset)
      offset += value.byteLength
    }
    // A short read (fewer bytes than declared) copies down to the actual
    // size, so the oversized backing buffer can be GC'd instead of kept alive
    // by a `subarray` view over it; the common, fully-filled case above
    // returns `out` itself with no extra copy.
    return offset === declaredLength ? out : out.slice(0, offset)
  }

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
