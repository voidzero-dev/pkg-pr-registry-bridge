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
import {
  getConfiguredRefs,
  getConfiguredRefsWithEtag,
  latestVersionByPr,
  registerRef,
  unregisterRef,
} from './preview/getConfiguredRefs'
import { parseConfiguredPreviewRefs } from './preview/parseConfiguredPreviewRefs'
import {
  readMetaIndex,
  removeFromMetaIndex,
  resolveVersionMeta,
  upsertMetaIndex,
} from './preview/metaIndex'
import {
  parseNpmTarballPath,
  parsePackagePath,
  parsePkgPrNewDownload,
  parseTarballPath,
  parseUploadPath,
} from './registry/parsePackageName'
import {
  getNpmPackumentCached,
  getNpmTimeCached,
} from './registry/fetchNpmPackument'
import { buildVersionMetadata } from './registry/buildVersionMetadata'
import { redirectToNpm } from './registry/redirectToNpm'
import {
  getPreviewMeta,
  getPreviewTarballBody,
} from './tarball/getPreviewBuild'
import type { PreviewMeta } from './tarball/buildPreviewTarball'
import {
  casKey,
  casVersionPrefix,
  isShasum,
  metaKey,
  tarballContentUrl,
  tarballKey,
  tarballUrl,
} from './cache/r2Cache'
import { kvCachedText } from './cache/kvCache'
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

// Output cache for the assembled packument. Void does not edge-cache the Worker
// response, so without this the ~440KB packument is re-assembled and re-stringified
// on every request. Keyed by the refs-index etag, which changes on every ref
// mutation; a short TTL bounds npm stable-version drift (preview freshness comes
// from the etag, not the TTL).
const PACKUMENT_OUT_PREFIX = 'pkgt/'
const PACKUMENT_OUT_TTL_S = 60

/** Build the packument HTTP response from an already-serialized body. */
function packumentResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': packumentCacheControl(),
    },
  })
}

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
  shasum?: string,
): Promise<Response> {
  assertPreviewTarget(env, name, version)
  const result = await getPreviewTarballBody(env, name, version, shasum)
  if (result.kind === 'redirect') {
    return new Response(null, {
      status: 302,
      headers: { location: result.location, 'cache-control': 'no-store' },
    })
  }
  // Content-addressed bytes are immutable (the URL pins them); a version-
  // addressed body (no shasum published yet) is only short-lived cacheable
  // because the version->build mapping can still change.
  return new Response(result.body, {
    headers: {
      'content-type': 'application/gzip',
      'cache-control': result.immutable ? tarballCacheControl() : packumentCacheControl(),
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
  // Point at the version's CURRENT build's content URL when a shasum is
  // published (so the download resolves the exact advertised bytes), else the
  // version URL (nothing published yet, or a meta without a shasum).
  const meta = await resolveVersionMeta(env, download.pkg, version)
  const location =
    meta && isShasum(meta.shasum)
      ? tarballContentUrl(env, download.pkg, version, meta.shasum)
      : tarballUrl(env, download.pkg, version)
  return new Response(null, {
    status: 302,
    headers: { ...headers, location },
  })
}

/** Preview tarball endpoint: serve from R2, else (platform) redirect upstream. */
app.get('/tarballs/*', async (c) => {
  const parsed = parseTarballPath(new URL(c.req.url).pathname)
  if (!parsed) throw new HttpError(404, 'Not found')
  // `await` so a thrown HttpError unwinds inside this handler's frame and is
  // routed to onError, rather than rejecting the returned promise unhandled.
  return await serveTarball(c.env, parsed.name, parsed.version, parsed.shasum)
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
  const { name, version, shasum } = parsed
  assertPreviewTarget(c.env, name, version)
  if (!c.req.raw.body) throw new HttpError(400, 'Missing request body')
  // Store content-addressed (keyed by the shasum in the path) when the upload
  // is a content path; else fall back to the legacy version-addressed key.
  const key = isShasum(shasum) ? casKey(name, version, shasum) : tarballKey(name, version)
  await c.env.STORAGE.put(key, c.req.raw.body, {
    httpMetadata: {
      contentType: 'application/gzip',
      cacheControl: tarballCacheControl(),
    },
  })
  return c.json(
    { uploaded: { package: name, version, ...(isShasum(shasum) ? { shasum } : {}) } },
    201,
  )
})

/**
 * Publish preview metadata (admin). Body: `{ "ref": "commit.<sha>",
 * "packages": [{ name, version, packageJson, integrity, shasum }] }`. The
 * publish action calls this right AFTER uploading each package's tarball, so a
 * stored meta-with-integrity always has its bytes in R2 and the two can never
 * diverge for longer than one package's upload. Each package's meta is what
 * the packument serves (package.json fields + integrity).
 *
 * Publishing does NOT register the ref: the version stays invisible until the
 * final `/-/register` call flips it on atomically, so a run cancelled mid-way
 * leaves only invisible artifacts instead of a mixed served state.
 */
app.post('/-/publish', async (c) => {
  admin(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    ref?: string
    packages?: Array<{
      name?: string
      version?: string
      packageJson?: Record<string, any>
      integrity?: string
      shasum?: string
    }>
  }
  const ref = (body.ref ?? '').trim()
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
    packages.map(async (pkg) => {
      const name = pkg.name!
      const version = pkg.version!
      const meta: PreviewMeta = {
        packageJson: pkg.packageJson ?? { name, version },
        shasum: pkg.shasum ?? '',
        integrity: pkg.integrity ?? '',
        publishedAt,
      }
      // `metaKey` is the per-version source of truth (and the packument's
      // migration fallback); the meta-index is the per-package aggregate the
      // packument reads in one shot regardless of how many refs exist.
      await Promise.all([
        c.env.STORAGE.put(metaKey(name, version), JSON.stringify(meta), {
          httpMetadata: {
            contentType: 'application/json',
            cacheControl: tarballCacheControl(),
          },
        }),
        upsertMetaIndex(c.env, name, version, meta),
      ])
      return `${name}@${version}`
    }),
  )

  let parsed
  try {
    // Validate the ref shape (the version being published must belong to a
    // well-formed commit ref); registration itself happens on /-/register.
    parsed = parseConfiguredPreviewRefs(ref)[0]
  } catch (err) {
    throw new HttpError(400, `Invalid ref: ${ref} (${err})`)
  }
  return c.json({ ref, version: parsed.version, published }, 201)
})

/**
 * Register a ref (admin), making its published versions visible in packuments.
 * Body: `{ "ref": "commit.<sha>", "prUrl"?: string }`. The publish action
 * calls this ONCE, after every package's tarball + meta are stored, so a new
 * version appears atomically with all its artifacts in place. The publish
 * time is stamped server-side here (the moment the release became visible).
 */
app.post('/-/register', async (c) => {
  admin(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    ref?: string
    prUrl?: string
  }
  const ref = (body.ref ?? '').trim()
  // Optional: the action runs on push commits too, where there is no PR.
  const prUrl = (body.prUrl ?? '').trim() || undefined
  if (!ref) throw new HttpError(400, 'Missing ref')

  const publishedAt = new Date().toISOString()
  let parsed
  try {
    parsed = await registerRef(c.env, ref, { publishedAt, prUrl })
  } catch (err) {
    throw new HttpError(400, `Invalid or unregisterable ref: ${ref} (${err})`)
  }
  return c.json({ ref, version: parsed.version, publishedAt }, 201)
})

/** List the registered preview refs (the runtime R2 index). Public read. */
app.get('/-/refs', async (c) => {
  const refs = await getConfiguredRefs(c.env)
  return c.json({
    refs: refs.map((r) => ({
      ref: `${r.type}.${r.ref}`,
      version: r.version,
      publishedAt: r.publishedAt ?? null,
      prUrl: r.prUrl ?? null,
      // ISO TTL (90 days out), refreshed on each (re)publish.
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    })),
  })
})

/**
 * Purge a generated build from R2. Body:
 * `{ "package": "vite-plus", "version": "0.0.0-commit.<sha>", "unregister"?: boolean }`.
 *
 * `unregister: true` also removes the version's ref from the runtime index
 * (e.g. to fully clean up a smoke-test artifact). It is opt-in because the ref
 * is shared by every package published at that version: unregistering hides
 * them all, while a plain purge only removes this one package's artifacts.
 */
app.post('/-/purge', async (c) => {
  admin(c)
  const body = (await c.req.json().catch(() => ({}))) as {
    package?: string
    version?: string
    unregister?: boolean
  }
  const name = body.package ?? ''
  const version = body.version ?? ''

  if (!isWorkspacePackage(name, c.env)) {
    throw new HttpError(400, `Unknown preview package: ${name || '(empty)'}`)
  }
  const parsed = parsePreviewVersion(version)
  if (!parsed) {
    throw new HttpError(400, `Invalid preview version: ${version || '(empty)'}`)
  }

  // Every content-addressed build of the version lives under casVersionPrefix
  // (one object per shasum). Delete them all, so NO /tarballs/.../<shasum>.tgz
  // stays installable after a purge, not just the current build's. Page through
  // the listing (a heavily re-run commit can exceed one 1000-key list page, and
  // R2 bulk delete also caps at 1000 keys), deleting each page as we go.
  let cursor: string | undefined
  do {
    const listing = await c.env.STORAGE.list({
      prefix: casVersionPrefix(name, version),
      cursor,
    })
    if (listing.objects.length > 0) {
      await c.env.STORAGE.delete(listing.objects.map((o) => o.key))
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)
  await Promise.all([
    c.env.STORAGE.delete(tarballKey(name, version)),
    c.env.STORAGE.delete(metaKey(name, version)),
    removeFromMetaIndex(c.env, name, version),
    ...(body.unregister === true
      ? [unregisterRef(c.env, `${parsed.type}.${parsed.ref}`)]
      : []),
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

  // Read the refs first: its etag keys the output cache below, and the refs feed
  // the assembly on a miss. Any ref change rewrites the index → new etag → the
  // key changes → automatic invalidation (no explicit purge), and R2 is strongly
  // consistent read-after-write, so a just-published preview shows up on the very
  // next request.
  const { refs, etag } = await getConfiguredRefsWithEtag(c.env)
  const cacheKey = `${PACKUMENT_OUT_PREFIX}${name}/${etag ?? 'none'}`

  const body = await kvCachedText(c.env, cacheKey, PACKUMENT_OUT_TTL_S, async () => {
    // Miss: the npm packument fetch, the npm `time` fetch, and the per-package
    // meta aggregate are independent, so overlap them. `time` comes from npm's
    // FULL packument (the abbreviated form we serve omits it) but is sourced
    // separately so the served response keeps the compact abbreviated version
    // docs. `metaIndex` is read ONCE here instead of one key per ref, so this
    // rebuild's subrequest count stays flat no matter how many refs exist.
    const [base, npmTime, metaIndex] = await Promise.all([
      getNpmPackumentCached(c.env, name),
      getNpmTimeCached(c.env, name),
      readMetaIndex(c.env, name),
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

    // Inject each configured ref from the meta aggregate read above. A ref
    // missing from the aggregate falls back to its per-version key: this covers
    // both refs published before the aggregate existed (fades as they republish
    // or expire within REF_TTL_MS) and an absent/corrupt aggregate (readMetaIndex
    // returns {}), so the fallback is a permanent degraded path, not just a
    // migration artifact. A failing ref is isolated so it can't break installs of
    // the package's other versions.
    await Promise.all(
      refs.map(async (ref) => {
        try {
          const preview =
            metaIndex[ref.version] ??
            (await getPreviewMeta(c.env, name, ref.version))
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

    return JSON.stringify(packument)
  })

  return packumentResponse(body)
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

export default { fetch: app.fetch } satisfies ExportedHandler<Env>
