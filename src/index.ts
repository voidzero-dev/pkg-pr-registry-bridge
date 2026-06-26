import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env } from './config'
import { HttpError } from './httpError'
import { isPreviewPackage } from './preview/packages'
import { parsePreviewVersion } from './preview/parsePreviewVersion'
import { parseConfiguredPreviewRefsSafe } from './preview/parseConfiguredPreviewRefs'
import {
  parsePackagePath,
  parseTarballPath,
} from './registry/parsePackageName'
import { fetchNpmPackument } from './registry/fetchNpmPackument'
import { buildVersionMetadata } from './registry/buildVersionMetadata'
import { proxyToNpm } from './registry/proxyToNpm'
import { getPreviewBuild } from './tarball/getPreviewBuild'
import {
  packumentCacheControl,
  tarballCacheControl,
} from './cache/headers'

type HonoEnv = { Bindings: Env }

const app = new Hono<HonoEnv>()

app.get('/_health', (c) => c.json({ status: 'ok' }))

/**
 * Preview tarball endpoint. Serves a generated tarball from the edge cache,
 * then R2, then by generating it from pkg.pr.new.
 */
app.get('/tarballs/*', async (c) => {
  const parsed = parseTarballPath(new URL(c.req.url).pathname)
  if (!parsed) throw new HttpError(404, 'Not found')

  const { name, version } = parsed
  if (!isPreviewPackage(name)) {
    throw new HttpError(404, `Unknown preview package: ${name}`)
  }
  if (!parsePreviewVersion(version)) {
    throw new HttpError(400, `Invalid preview version: ${version}`)
  }

  const cache = caches.default
  const cacheKey = new Request(c.req.url, { method: 'GET' })
  const hit = await cache.match(cacheKey)
  if (hit) return hit

  const build = await getPreviewBuild(c.env, c.executionCtx, name, version)
  const res = new Response(build.tarball, {
    headers: {
      'content-type': 'application/gzip',
      'cache-control': tarballCacheControl(version),
    },
  })
  c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()))
  return res
})

/** Cache purge endpoint (MVP2). */
app.post('/-/purge', (c) => c.json({ error: 'Not implemented' }, 501))

/**
 * Packument endpoint and default-registry fallback.
 *
 *  - Allowlisted package: fetch the npm packument (or synthesize an empty one
 *    if absent from npm), inject configured preview versions, return.
 *  - Everything else: transparent proxy to npm.
 */
app.get('*', async (c) => {
  const pkgReq = parsePackagePath(new URL(c.req.url).pathname)
  if (!pkgReq) return proxyToNpm(c.env, c.req.raw)

  const { name } = pkgReq
  if (!isPreviewPackage(name)) return proxyToNpm(c.env, c.req.raw)

  const accept = c.req.header('accept') ?? 'application/json'
  const base = await fetchNpmPackument(c.env, name, accept)

  const packument: Record<string, any> =
    base.status === 200 && base.data
      ? base.data
      : { name, 'dist-tags': {}, versions: {} }

  packument.name = name
  packument['dist-tags'] ??= {}
  packument.versions ??= {}

  const refs = parseConfiguredPreviewRefsSafe(c.env.VITE_PLUS_PREVIEW_REFS)
  for (const ref of refs) {
    try {
      const build = await getPreviewBuild(
        c.env,
        c.executionCtx,
        name,
        ref.version,
      )
      packument.versions[ref.version] = buildVersionMetadata(
        c.env,
        name,
        ref.version,
        build.packageJson,
      )
      packument['dist-tags'][ref.tag] = ref.version
    } catch (err) {
      // A failing ref must not break installs of the package's other versions.
      console.warn(`Failed to inject preview ref ${ref.version}:`, err)
    }
  }

  return new Response(JSON.stringify(packument), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': packumentCacheControl(refs),
    },
  })
})

/** Non-GET methods fall through to npm. */
app.all('*', (c) => proxyToNpm(c.env, c.req.raw))

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode)
  }
  console.error('Unhandled error:', err)
  return c.json({ error: 'Internal error' }, 500)
})

export default app
