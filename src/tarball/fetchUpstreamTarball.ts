import { HttpError } from '../httpError'

async function fetchUpstream(url: string, maxBytes: number) {
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

  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new HttpError(413, 'Upstream tarball exceeds the maximum size')
  }
  return res.body
}

/**
 * Stream an upstream pkg.pr.new tarball, enforcing a maximum size as bytes flow
 * so a malicious or oversized upstream cannot exhaust the Worker. The body is
 * never buffered whole, which is what keeps the large platform-binary tarballs
 * within the Worker memory budget.
 */
export async function fetchUpstreamTarballStream(
  url: string,
  maxBytes: number,
): Promise<ReadableStream<Uint8Array>> {
  const body = await fetchUpstream(url, maxBytes)
  let total = 0
  return body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        total += chunk.byteLength
        if (total > maxBytes) {
          throw new HttpError(413, 'Upstream tarball exceeds the maximum size')
        }
        controller.enqueue(chunk)
      },
    }),
  )
}

/**
 * Download an upstream pkg.pr.new tarball into memory, enforcing a maximum size
 * while streaming. Used for the small preview packages whose integrity is
 * computed over the full bytes; large binaries use the streaming path instead.
 */
export async function fetchUpstreamTarball(
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const body = await fetchUpstream(url, maxBytes)

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new HttpError(413, 'Upstream tarball exceeds the maximum size')
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
