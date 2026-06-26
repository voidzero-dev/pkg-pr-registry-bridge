import type { Env } from '../config'

/** Headers that must not be forwarded to the upstream. */
const HOP_BY_HOP = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
])

/**
 * Transparent pass-through to the npm registry for everything the bridge does
 * not synthesize: non-allowlisted packuments, npm tarballs, registry APIs.
 */
export async function proxyToNpm(env: Env, req: Request): Promise<Response> {
  const url = new URL(req.url)
  const target = `${env.NPM_REGISTRY}${url.pathname}${url.search}`

  const headers = new Headers()
  for (const [key, value] of req.headers) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value)
  }

  const upstream = await fetch(target, {
    method: req.method,
    headers,
    redirect: 'follow',
  })

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: new Headers(upstream.headers),
  })
}
