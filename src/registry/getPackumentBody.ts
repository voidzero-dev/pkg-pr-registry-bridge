import type { Env } from '../config'
import { HttpError } from '../httpError'
import { kvCachedText } from '../cache/kvCache'
import { getConfiguredRefsWithEtag, latestVersionByPr } from '../preview/getConfiguredRefs'
import { readMetaIndex } from '../preview/metaIndex'
import { getPreviewMeta } from '../tarball/getPreviewBuild'
import { describeError } from '../util/errors'
import { RequestTiming, type RequestWork } from '../util/requestTiming'
import { withTimeout } from '../util/withTimeout'
import { buildVersionMetadata } from './buildVersionMetadata'
import { getNpmPackumentCached, getNpmTimeCached } from './fetchNpmPackument'

/**
 * Fallback `time` (release date) for a preview registered but not yet published
 * (or a platform binary before CI warms it). A fixed past date: deterministic
 * across requests, and old enough that `minimum-release-age` never filters a
 * pinned preview during that gap.
 */
const UNPUBLISHED_PREVIEW_TIME = '2020-01-01T00:00:00.000Z'

// Output cache for the assembled packument. Void does not edge-cache the Worker
// response, so without this the multi-MB packument is re-assembled and re-stringified
// on every request. Keyed by the refs-index etag, which changes on every ref
// mutation; a short TTL bounds npm stable-version drift (preview freshness comes
// from the etag, not the TTL).
const PACKUMENT_OUT_PREFIX = 'pkgt/'
const PACKUMENT_OUT_TTL_S = 60

// Leave room for framework/dispatch overhead before Void's 10s response deadline.
export const PACKUMENT_TIMEOUT_MS = 8000

export async function getPackumentBody(
  env: Env,
  name: string,
  executionCtx: Pick<ExecutionContext, 'waitUntil'>,
): Promise<string> {
  const controller = new AbortController()
  const timing = new RequestTiming()
  const work: RequestWork = { executionCtx, timing, signal: controller.signal }
  let status = 200
  try {
    return await withTimeout(buildPackument(env, name, work), PACKUMENT_TIMEOUT_MS, () => {
      const error = new HttpError(504, `Packument response timed out for ${name}`)
      controller.abort(error)
      return error
    })
  } catch (err) {
    status = err instanceof HttpError ? err.status : 500
    controller.abort(err)
    throw err
  } finally {
    timing.log(name, status)
  }
}

async function buildPackument(env: Env, name: string, work: RequestWork): Promise<string> {
  // Read the refs first: its etag keys the output cache below, and the refs feed
  // the assembly on a miss. Any ref change rewrites the index → new etag → the
  // key changes → automatic invalidation (no explicit purge), and R2 is strongly
  // consistent read-after-write, so a just-published preview shows up on the very
  // next request.
  const { refs, etag } = await work.timing.measure('r2.refs', () => getConfiguredRefsWithEtag(env))
  work.signal.throwIfAborted()
  work.timing.refs = refs.length
  const cacheKey = `${PACKUMENT_OUT_PREFIX}${name}/${etag ?? 'none'}`

  const body = await kvCachedText(
    env,
    cacheKey,
    PACKUMENT_OUT_TTL_S,
    async () => {
      // Miss: the npm packument fetch, the npm `time` fetch, and the per-package
      // meta aggregate are independent, so overlap them. `time` comes from npm's
      // FULL packument (the abbreviated form we serve omits it) but is sourced
      // separately so the served response keeps the compact abbreviated version
      // docs. `metaIndex` is read ONCE here instead of one key per ref, so this
      // rebuild's subrequest count stays flat no matter how many refs exist.
      const [base, npmTime, metaIndex] = await Promise.all([
        getNpmPackumentCached(env, name, work),
        getNpmTimeCached(env, name, work),
        work.timing.measure('r2.meta-index', () => readMetaIndex(env, name)),
      ])

      work.signal.throwIfAborted()
      const packument: Record<string, any> = base ?? { name, 'dist-tags': {}, versions: {} }

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
      work.timing.fallbackReads = refs.filter((ref) => !metaIndex[ref.version]).length
      await work.timing.measure('preview.inject', () =>
        Promise.all(
          refs.map(async (ref) => {
            try {
              const preview =
                metaIndex[ref.version] ?? (await getPreviewMeta(env, name, ref.version))
              packument.versions[ref.version] = buildVersionMetadata(
                env,
                name,
                ref.version,
                preview,
              )
              time[ref.version] = preview.publishedAt ?? UNPUBLISHED_PREVIEW_TIME
            } catch (err) {
              work.signal.throwIfAborted()
              console.warn(
                `Failed to inject preview ref ${ref.version} into ${name}:`,
                describeError(err),
              )
            }
          }),
        ),
      )

      // Mutable `pr-<n>` dist-tags: point each PR at its latest-published commit
      // version present in this packument, so `<pkg>@pr-<n>` installs the PR's head
      // build. The per-commit versions stay immutable; only the tag moves.
      for (const [prNum, version] of latestVersionByPr(refs, (v) => v in packument.versions)) {
        packument['dist-tags'][`pr-${prNum}`] = version
      }

      work.signal.throwIfAborted()
      return JSON.stringify(packument)
    },
    work,
  )

  return body
}
