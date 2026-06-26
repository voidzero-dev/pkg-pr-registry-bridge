import { HttpError } from '../httpError'

/**
 * Download an upstream pkg.pr.new tarball, enforcing a maximum size while
 * streaming so a malicious or oversized upstream cannot exhaust the Worker.
 */
export async function fetchUpstreamTarball(
  url: string,
  maxBytes: number,
): Promise<Uint8Array> {
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

  const reader = res.body.getReader()
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
