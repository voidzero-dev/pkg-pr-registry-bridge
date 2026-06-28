import { Hono } from 'hono'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env } from './config'
import { HttpError } from './httpError'
import { isWorkspacePackage } from './preview/packages'
import { parsePreviewVersion } from './preview/parsePreviewVersion'
import { parseConfiguredPreviewRefs } from './preview/parseConfiguredPreviewRefs'
import {
  getConfiguredRefs,
  registerRef,
  unregisterRef,
} from './preview/getConfiguredRefs'
import {
  parseNpmTarballPath,
  parsePackagePath,
  parseTarballPath,
} from './registry/parsePackageName'
import { fetchNpmPackument } from './registry/fetchNpmPackument'
import { buildVersionMetadata } from './registry/buildVersionMetadata'
import { redirectToNpm } from './registry/redirectToNpm'
import { getPreviewMeta, getPreviewTarballBody } from './tarball/getPreviewBuild'
import { metaKey, tarballKey } from './cache/r2Cache'
import { requireAdmin } from './security/auth'
import { verifyRefExists } from './github/verifyRef'
import {
  isPkgPrNewComment,
  refsFromBotComment,
  verifyGitHubSignature,
} from './github/webhook'
import {
  packumentCacheControl,
  tarballCacheControl,
} from './cache/headers'

type HonoEnv = { Bindings: Env }

const app = new Hono<HonoEnv>()

app.get('/_health', (c) => c.json({ status: 'ok' }))

const admin = (c: { req: { header: (k: string) => string | undefined }; env: Env }) =>
  requireAdmin({ env: c.env, authorization: c.req.header('authorization') })

/**
 * Serve a generated preview tarball from R2 (built together with the meta
 * integrity), never the per-colo Cache API. An edge-cached tarball can outlive a
 * content change and then mismatch the integrity advertised in the packument
 * (IntegrityCheckFailed). R2 is the single source of truth.
 */
async function serveTarball(
  env: Env,
  name: string,
  version: string,
  requestUrl: string,
): Promise<Response> {
  if (!isWorkspacePackage(name, env)) {
    throw new HttpError(404, `Unknown preview package: ${name}`)
  }
  if (!parsePreviewVersion(version)) {
    throw new HttpError(400, `Invalid preview version: ${version}`)
  }
  const result = await getPreviewTarballBody(env, name, version)
  if (result.kind === 'redirect') {
    // Just built into R2; redirect to the same URL so the cached path serves it.
    return new Response(null, {
      status: 302,
      headers: { location: requestUrl, 'cache-control': 'no-store' },
    })
  }
  const headers: Record<string, string> = {
    'content-type': 'application/gzip',
    'cache-control': tarballCacheControl(),
  }
  if (result.contentLength !== undefined) {
    headers['content-length'] = String(result.contentLength)
  }
  return new Response(result.body, { headers })
}

/**
 * Preview tarball endpoint. Serves a generated tarball from R2, then by
 * generating it from pkg.pr.new.
 */
app.get('/tarballs/*', async (c) => {
  const parsed = parseTarballPath(new URL(c.req.url).pathname)
  if (!parsed) throw new HttpError(404, 'Not found')
  // `await` so a thrown HttpError unwinds inside this handler's frame and is
  // routed to onError, rather than rejecting the returned promise unhandled.
  return await serveTarball(c.env, parsed.name, parsed.version, c.req.url)
})

/** List the configured preview refs (static env + runtime KV). Public read. */
app.get('/-/refs', async (c) => {
  const refs = await getConfiguredRefs(c.env)
  return c.json({
    refs: refs.map((r) => ({
      ref: `${r.type}.${r.ref}`,
      version: r.version,
      tag: r.tag,
    })),
  })
})

/**
 * Register a preview ref at runtime (no redeploy). Body:
 * `{ "ref": "commit.<sha>" }`. When `GITHUB_TOKEN` is set, the ref is
 * verified to exist in the repo before being accepted.
 */
app.post('/-/refs', async (c) => {
  admin(c)
  const body = (await c.req.json().catch(() => ({}))) as { ref?: string }
  const ref = (body.ref ?? '').trim()

  let parsed
  try {
    ;[parsed] = parseConfiguredPreviewRefs(ref)
  } catch {
    throw new HttpError(400, `Invalid ref: ${ref || '(empty)'}`)
  }

  if (c.env.GITHUB_TOKEN) {
    let exists: boolean
    try {
      exists = await verifyRefExists(c.env, parsed)
    } catch (err) {
      throw new HttpError(502, `Could not verify ref with GitHub: ${err}`)
    }
    if (!exists) {
      throw new HttpError(
        404,
        `Ref not found in ${c.env.PREVIEW_OWNER}/${c.env.PREVIEW_REPO}: ${ref}`,
      )
    }
  }

  try {
    await registerRef(c.env, ref)
  } catch (err) {
    throw new HttpError(503, String(err))
  }
  return c.json({ added: ref, version: parsed.version, tag: parsed.tag }, 201)
})

/** Unregister a runtime preview ref. Body: `{ "ref": "commit.<sha>" }`. */
app.delete('/-/refs', async (c) => {
  admin(c)
  const body = (await c.req.json().catch(() => ({}))) as { ref?: string }
  const ref = (body.ref ?? '').trim()
  try {
    await unregisterRef(c.env, ref)
  } catch (err) {
    throw new HttpError(400, String(err))
  }
  return c.json({ removed: ref })
})

/**
 * GitHub webhook receiver. Configure a repo webhook (content-type
 * application/json, the `Issue comments` event) pointing here with a shared
 * secret. When the pkg.pr.new bot comments on a PR (i.e. a build was just
 * published), the PR ref and the build's commit refs are auto-registered, so
 * new previews become installable with no redeploy and no manual call.
 */
app.post('/-/webhook', async (c) => {
  const secret = c.env.GITHUB_WEBHOOK_SECRET
  if (!secret) throw new HttpError(503, 'Webhook is not configured')

  const raw = await c.req.text()
  const signature = c.req.header('x-hub-signature-256') ?? ''
  if (!(await verifyGitHubSignature(secret, raw, signature))) {
    throw new HttpError(401, 'Invalid signature')
  }

  const event = c.req.header('x-github-event')
  if (event === 'ping') return c.json({ ok: true })

  let payload: any
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new HttpError(400, 'Invalid JSON payload')
  }

  if (!isPkgPrNewComment(event, payload)) {
    return c.json({ ignored: event ?? 'unknown' })
  }

  const refs = refsFromBotComment(payload.comment.body ?? '')
  const registered: string[] = []
  for (const ref of refs) {
    try {
      const parsed = await registerRef(c.env, ref)
      registered.push(parsed.version)
    } catch (err) {
      console.warn(`Webhook failed to register ref ${ref}:`, err)
    }
  }
  return c.json({ registered })
})

/**
 * Purge a generated build from the caches. Body:
 * `{ "package": "vite-plus", "version": "0.0.0-commit.<sha>" }`.
 */
app.post('/-/purge', async (c) => {
  admin(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    package?: string
    version?: string
  }
  const name = body.package ?? ''
  const version = body.version ?? ''

  if (!isWorkspacePackage(name, c.env)) {
    throw new HttpError(400, `Unknown preview package: ${name || '(empty)'}`)
  }
  if (!parsePreviewVersion(version)) {
    throw new HttpError(400, `Invalid preview version: ${version || '(empty)'}`)
  }

  await Promise.all([
    c.env.TARBALL_CACHE.delete(tarballKey(name, version)),
    c.env.TARBALL_CACHE.delete(metaKey(name, version)),
    caches.default.delete(
      new Request(`${c.env.PUBLIC_BASE_URL}/tarballs/${name}/${version}.tgz`),
    ),
  ])
  return c.json({ purged: { package: name, version } })
})

/**
 * Packument endpoint, npm-convention tarball alias, and default-registry
 * fallback.
 *
 *  - npm-convention tarball path for a preview build: serve it (see below).
 *  - Allowlisted package: fetch the npm packument (or synthesize an empty one
 *    if absent from npm), inject configured preview versions, return.
 *  - Everything else: redirect to npm so the client fetches it directly.
 */
app.get('*', async (c) => {
  const pathname = new URL(c.req.url).pathname

  // npm-convention tarball path (/<name>/-/<basename>-<version>.tgz). Clients
  // should read dist.tarball (which points at /tarballs/...), but some, and
  // stale lockfiles, synthesize this path instead. Serve preview builds here
  // too; non-preview packages/versions fall through to the npm redirect below.
  const npmTarball = parseNpmTarballPath(pathname)
  if (
    npmTarball &&
    isWorkspacePackage(npmTarball.name, c.env) &&
    parsePreviewVersion(npmTarball.version)
  ) {
    return await serveTarball(c.env, npmTarball.name, npmTarball.version, c.req.url)
  }

  const pkgReq = parsePackagePath(pathname)
  if (!pkgReq) return redirectToNpm(c.env, c.req.raw)

  const { name } = pkgReq
  if (!isWorkspacePackage(name, c.env)) return redirectToNpm(c.env, c.req.raw)

  const base = await fetchNpmPackument(c.env, name)

  const packument: Record<string, any> =
    base.status === 200 && base.data
      ? base.data
      : { name, 'dist-tags': {}, versions: {} }

  packument.name = name
  packument['dist-tags'] ??= {}
  packument.versions ??= {}

  // Inject each configured ref. The R2 meta reads are independent, so run them
  // concurrently; each writes a distinct version/tag key, and a failing ref is
  // isolated so it can't break installs of the package's other versions. After
  // the deploy-time warm step these are R2 hits and don't touch the upstream.
  const refs = await getConfiguredRefs(c.env)
  await Promise.all(
    refs.map(async (ref) => {
      try {
        const preview = await getPreviewMeta(c.env, name, ref.version)
        packument.versions[ref.version] = buildVersionMetadata(
          c.env,
          name,
          ref.version,
          preview,
        )
        packument['dist-tags'][ref.tag] = ref.version
      } catch (err) {
        console.warn(`Failed to inject preview ref ${ref.version}:`, err)
      }
    }),
  )

  return new Response(JSON.stringify(packument), {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': packumentCacheControl(),
    },
  })
})

/** Non-GET methods fall through to npm. */
app.all('*', (c) => redirectToNpm(c.env, c.req.raw))

app.onError((err, c) => {
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode)
  }
  console.error('Unhandled error:', err)
  return c.json({ error: 'Internal error' }, 500)
})

export default app
