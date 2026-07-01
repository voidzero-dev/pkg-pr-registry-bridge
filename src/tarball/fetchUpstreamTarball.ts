import { HttpError } from '../httpError'

/** Initial buffer capacity when the upstream doesn't declare a usable size. */
const DEFAULT_INITIAL_CAPACITY = 64 * 1024

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

/**
 * Download an upstream pkg.pr.new tarball into memory, enforcing a maximum size
 * while streaming so a malicious or oversized upstream cannot exhaust the
 * Worker.
 *
 * Pre-sizes the buffer from `Content-Length` when the upstream declares one
 * (the common case), so a fully-filled download streams straight into one
 * buffer with no extra copy at the end. `Content-Length` is only a sizing
 * HINT here, never a hard cap: the limit actually enforced is always
 * `maxBytes`, so an upstream that under-reports its own size (a re-chunking
 * proxy, an off-by-a-few-bytes header) still downloads successfully instead of
 * failing with a spurious "too large". A wrong guess just grows the buffer
 * (capped at `maxBytes`), the same bound the no-declared-length case starts
 * from.
 */
export async function fetchUpstreamTarball(
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const { body, declaredLength } = await fetchUpstream(url, maxBytes)
  const reader = body.getReader()

  let out = new Uint8Array(
    Math.min(declaredLength ?? DEFAULT_INITIAL_CAPACITY, maxBytes),
  )
  let offset = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const end = offset + value.byteLength
    if (end > maxBytes) {
      await reader.cancel()
      throw new HttpError(413, 'Upstream tarball exceeds the maximum size')
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
