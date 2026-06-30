import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { ContentfulStatusCode } from 'hono/utils/http-status'
import type { Env } from './config'
import { HttpError } from './httpError'
import { isWorkspacePackage } from './preview/packages'
import {
  parsePreviewVersion,
  shaToVersion,
} from './preview/parsePreviewVersion'
import { parseConfiguredPreviewRefs } from './preview/parseConfiguredPreviewRefs'
import {
  getConfiguredRefs,
  latestVersionByPr,
  registerRef,
  unregisterRef,
} from './preview/getConfiguredRefs'
import {
  parseNpmTarballPath,
  parsePackagePath,
  parsePkgPrNewDownload,
  parseTarballPath,
  parseUploadPath,
} from './registry/parsePackageName'
import {
  fetchNpmPackument,
  getNpmTimeCached,
} from './registry/fetchNpmPackument'
import { buildVersionMetadata } from './registry/buildVersionMetadata'
import { redirectToNpm } from './registry/redirectToNpm'
import {
  getPreviewMeta,
  getPreviewTarballBody,
} from './tarball/getPreviewBuild'
import type { PreviewMeta } from './tarball/buildPreviewTarball'
import { metaKey, tarballKey, tarballUrl } from './cache/r2Cache'
import { requireAdmin } from './security/auth'
import {
  packumentCacheControl,
  tarballCacheControl,
} from './cache/headers'

/**
 * Fallback `time` (release date) for a preview registered but not yet published
 * (or a platform binary before CI warms it). A fixed past date: deterministic
 * across requests, and old enough that `minimum-release-age` never filters a
 * pinned preview during that gap.
 */
const UNPUBLISHED_PREVIEW_TIME = '2020-01-01T00:00:00.000Z'

type HonoEnv = { Bindings: Env }

export const app = new Hono<HonoEnv>()

// Allow browser clients to read every response (this is a public, read-mostly
// registry API). Mirrors pkg.pr.new's `access-control-allow-origin: *`.
app.use('*', cors())

app.get('/_health', (c) => c.json({ status: 'ok' }))

const admin = (c: { req: { header: (k: string) => string | undefined }; env: Env }) =>
  requireAdmin({ env: c.env, authorization: c.req.header('authorization') })

/**
 * Validate a preview (name, version) target. `unknownStatus` is 404 on the serve
 * paths (the resource isn't found) and 400 on the admin write paths (bad input).
 */
function assertPreviewTarget(
  env: Env,
  name: string,
  version: string,
  unknownStatus = 404,
): void {
  if (!isWorkspacePackage(name, env)) {
    throw new HttpError(unknownStatus, `Unknown preview package: ${name || '(empty)'}`)
  }
  if (!parsePreviewVersion(version)) {
    throw new HttpError(400, `Invalid preview version: ${version || '(empty)'}`)
  }
}

/**
 * Serve a preview tarball from R2, the single source of truth (never the
 * per-colo Cache API: an edge-cached tarball can outlive a content change and
 * then mismatch the integrity advertised in the packument). A platform binary
 * not yet uploaded by CI redirects to pkg.pr.new, which serves identical bytes.
 */
async function serveTarball(
  env: Env,
  name: string,
  version: string,
): Promise<Response> {
  assertPreviewTarget(env, name, version)
  const result = await getPreviewTarballBody(env, name, version)
  if (result.kind === 'redirect') {
    return new Response(null, {
      status: 302,
      headers: { location: result.location, 'cache-control': 'no-store' },
    })
  }
  return new Response(result.body, {
    headers: {
      'content-type': 'application/gzip',
      'cache-control': tarballCacheControl(),
      'content-length': String(result.contentLength),
    },
  })
}

/**
 * Resolve a pkg.pr.new-style download (a PR number -> its latest commit
 * version, or a commit sha -> its synthetic version). A GET 302s to the
 * canonical tarball; a HEAD answers 200 with no body, so a client can map a
 * (possibly mutable) PR/sha to its exact commit without downloading. Both carry
 * pkg.pr.new-style `x-commit-key` (`<owner>:<repo>:<sha>`) and `x-pkg-name-key`.
 * The PR mapping is mutable, so the response is not cached; the immutable
 * tarball it points at is.
 */
async function serveDownloadRedirect(
  env: Env,
  download: { pkg: string; ref: string },
  head: boolean,
): Promise<Response> {
  if (!isWorkspacePackage(download.pkg, env)) {
    throw new HttpError(404, `Unknown package: ${download.pkg}`)
  }
  const version = /^\d+$/.test(download.ref)
    ? (latestVersionByPr(await getConfiguredRefs(env)).get(download.ref) ?? null)
    : shaToVersion(download.ref)
  if (!version) {
    throw new HttpError(404, `No preview build for ref ${download.ref}`)
  }
  const sha = parsePreviewVersion(version)?.ref ?? ''
  const headers: Record<string, string> = {
    'x-commit-key': `${env.PREVIEW_OWNER}:${env.PREVIEW_REPO}:${sha}`,
    'x-pkg-name-key': download.pkg,
    'cache-control': 'no-store',
  }
  if (head) {
    return new Response(null, {
      status: 200,
      headers: { ...headers, 'content-type': 'application/tar+gzip' },
    })
  }
  return new Response(null, {
    status: 302,
    headers: { ...headers, location: tarballUrl(env, download.pkg, version) },
  })
}

/** Preview tarball endpoint: serve from R2, else (platform) redirect upstream. */
app.get('/tarballs/*', async (c) => {
  const parsed = parseTarballPath(new URL(c.req.url).pathname)
  if (!parsed) throw new HttpError(404, 'Not found')
  // `await` so a thrown HttpError unwinds inside this handler's frame and is
  // routed to onError, rather than rejecting the returned promise unhandled.
  return await serveTarball(c.env, parsed.name, parsed.version)
})

/**
 * Upload a prebuilt tarball (admin). The publish action builds and hashes the
 * artifacts in CI (no per-invocation CPU/memory limit there) and PUTs the bytes
 * here; the Worker streams the request body straight into R2, a passthrough that
 * never buffers or hashes the payload, so it cannot OOM regardless of size.
 */
app.put('/-/tarball/*', async (c) => {
  admin(c)
  const parsed = parseUploadPath(new URL(c.req.url).pathname)
  if (!parsed) throw new HttpError(404, 'Not found')
  const { name, version } = parsed
  assertPreviewTarget(c.env, name, version)
  if (!c.req.raw.body) throw new HttpError(400, 'Missing request body')
  await c.env.STORAGE.put(tarballKey(name, version), c.req.raw.body, {
    httpMetadata: {
      contentType: 'application/gzip',
      cacheControl: tarballCacheControl(),
    },
  })
  return c.json({ uploaded: { package: name, version } }, 201)
})

/**
 * Publish preview metadata and register the ref (admin), in one call. Body:
 * `{ "ref": "commit.<sha>", "packages": [{ name, version, packageJson,
 * integrity, shasum }] }`. The publish action calls this AFTER uploading the
 * tarballs, so a stored meta-with-integrity always has its bytes in R2. Each
 * package's meta is what the packument serves (package.json fields + integrity).
 */
app.post('/-/publish', async (c) => {
  admin(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    ref?: string
    prUrl?: string
    packages?: Array<{
      name?: string
      version?: string
      packageJson?: Record<string, any>
      integrity?: string
      shasum?: string
    }>
  }
  const ref = (body.ref ?? '').trim()
  // Optional: the action runs on push commits too, where there is no PR.
  const prUrl = (body.prUrl ?? '').trim() || undefined
  const packages = Array.isArray(body.packages) ? body.packages : []
  if (!ref) throw new HttpError(400, 'Missing ref')
  if (packages.length === 0) throw new HttpError(400, 'Missing packages')

  // Validate everything up front (so a bad package can't leave half-written
  // metas), then write the independent meta keys in parallel.
  for (const pkg of packages) {
    assertPreviewTarget(c.env, pkg.name ?? '', pkg.version ?? '', 400)
  }
  // Stamp the publish time server-side (when the action submits), so every
  // package in this run shares one immutable release date. Any client-reported
  // time is ignored.
  const publishedAt = new Date().toISOString()
  const published = await Promise.all(
    packages.map((pkg) => {
      const name = pkg.name!
      const version = pkg.version!
      const meta: PreviewMeta = {
        packageJson: pkg.packageJson ?? { name, version },
        shasum: pkg.shasum ?? '',
        integrity: pkg.integrity ?? '',
        publishedAt,
      }
      return c.env.STORAGE.put(metaKey(name, version), JSON.stringify(meta), {
        httpMetadata: {
          contentType: 'application/json',
          cacheControl: tarballCacheControl(),
        },
      }).then(() => `${name}@${version}`)
    }),
  )

  let parsed
  try {
    // registerRef parses + validates the ref and returns it. Record this run's
    // server-stamped publish time and (when present) the source PR url.
    parsed = await registerRef(c.env, ref, { publishedAt, prUrl })
  } catch (err) {
    throw new HttpError(400, `Invalid or unregisterable ref: ${ref} (${err})`)
  }
  return c.json({ ref, version: parsed.version, published }, 201)
})

/** List the configured preview refs (static env + runtime R2 index). Public read. */
app.get('/-/refs', async (c) => {
  const refs = await getConfiguredRefs(c.env)
  return c.json({
    refs: refs.map((r) => ({
      ref: `${r.type}.${r.ref}`,
      version: r.version,
      publishedAt: r.publishedAt ?? null,
      prUrl: r.prUrl ?? null,
      // ISO TTL; null for static env refs, which never expire.
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    })),
  })
})

/**
 * Register a preview ref at runtime (no redeploy). Body:
 * `{ "ref": "commit.<sha>" }`.
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

  try {
    await registerRef(c.env, ref)
  } catch (err) {
    throw new HttpError(503, String(err))
  }
  // The tarballs/integrity are built and uploaded by the publish action (CI);
  // until then this ref's packument uses name-derived platform metas and the
  // tarball endpoint redirects platform binaries to pkg.pr.new.
  return c.json({ added: ref, version: parsed.version }, 201)
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
 * Purge a generated build from R2. Body:
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
    c.env.STORAGE.delete(tarballKey(name, version)),
    c.env.STORAGE.delete(metaKey(name, version)),
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
    return await serveTarball(c.env, npmTarball.name, npmTarball.version)
  }

  // pkg.pr.new-style direct download: /<owner>/<repo>[/<pkg>]@<ref> -> 302 to
  // the canonical tarball. Discriminated here (ahead of the packument parse)
  // because the URL shape overlaps the scoped-packument namespace.
  const download = parsePkgPrNewDownload(
    pathname,
    c.env.PREVIEW_OWNER,
    c.env.PREVIEW_REPO,
  )
  if (download) {
    return await serveDownloadRedirect(c.env, download, c.req.method === 'HEAD')
  }

  const pkgReq = parsePackagePath(pathname)
  if (!pkgReq) return redirectToNpm(c.env, c.req.raw)

  const { name } = pkgReq
  if (!isWorkspacePackage(name, c.env)) return redirectToNpm(c.env, c.req.raw)

  // The npm packument fetch, the npm `time` fetch, and the refs read are all
  // independent; overlap them. `time` comes from npm's FULL packument (the
  // abbreviated form we serve omits it) but is sourced separately so the served
  // response keeps the compact abbreviated version docs.
  const [base, npmTime, refs] = await Promise.all([
    fetchNpmPackument(c.env, name),
    getNpmTimeCached(c.env, name),
    getConfiguredRefs(c.env),
  ])

  const packument: Record<string, any> =
    base ?? { name, 'dist-tags': {}, versions: {} }

  packument.name = name
  packument['dist-tags'] ??= {}
  packument.versions ??= {}

  // pnpm's time-based resolution (`minimum-release-age`) hard-errors without a
  // `time` map (ERR_PNPM_MISSING_TIME). Seed it from npm's real publish times;
  // each injected preview version's entry is its server-stamped publish time
  // (UNPUBLISHED_PREVIEW_TIME until published), added in the loop below. `npmTime`
  // is a fresh per-request object (cache parse or fetch), so mutate it in place.
  const time: Record<string, string> = npmTime
  packument.time = time

  // Inject each configured ref. The R2 meta reads are independent, so run them
  // concurrently; each writes a distinct version/time key, and a failing ref is
  // isolated so it can't break installs of the package's other versions. After
  // the deploy-time warm step these are R2 hits and don't touch upstream.
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
        time[ref.version] = preview.publishedAt ?? UNPUBLISHED_PREVIEW_TIME
      } catch (err) {
        console.warn(`Failed to inject preview ref ${ref.version}:`, err)
      }
    }),
  )

  // Mutable `pr-<n>` dist-tags: point each PR at its latest-published commit
  // version present in this packument, so `<pkg>@pr-<n>` installs the PR's head
  // build. The per-commit versions stay immutable; only the tag moves.
  for (const [prNum, version] of latestVersionByPr(
    refs,
    (v) => v in packument.versions,
  )) {
    packument['dist-tags'][`pr-${prNum}`] = version
  }

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
  // Keep the CORS header on errors too, so a browser can read the error body.
  c.header('access-control-allow-origin', '*')
  if (err instanceof HttpError) {
    return c.json({ error: err.message }, err.status as ContentfulStatusCode)
  }
  console.error('Unhandled error:', err)
  return c.json({ error: 'Internal error' }, 500)
})

export default { fetch: app.fetch } satisfies ExportedHandler<Env>
