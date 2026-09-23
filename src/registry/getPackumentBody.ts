import type { Env } from '../config'
import { HttpError } from '../httpError'
import { kvCachedText } from '../cache/kvCache'
import { getConfiguredRefsWithEtag, latestVersionByPr } from '../preview/getConfiguredRefs'
import { readMetaIndex } from '../preview/metaIndex'
import type { ConfiguredPreviewRef } from '../preview/parseConfiguredPreviewRefs'
import { getPreviewMeta } from '../tarball/getPreviewBuild'
import { describeError } from '../util/errors'
import { RequestTiming, type RequestWork } from '../util/requestTiming'
import { withTimeout } from '../util/withTimeout'
import { buildVersionMetadata } from './buildVersionMetadata'
import { getNpmPackumentCached, getNpmTimeCached } from './fetchNpmPackument'

// Keep previews without a publish time eligible for minimum-release-age resolution.
const UNPUBLISHED_PREVIEW_TIME = '2020-01-01T00:00:00.000Z'

// Void forbids the Cache API. Cache the serialized response in KV, using the refs
// etag for preview freshness and a short TTL to bound npm stable-version drift.
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
    return await withTimeout(getCachedPackument(env, name, work), PACKUMENT_TIMEOUT_MS, () => {
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

async function getCachedPackument(env: Env, name: string, work: RequestWork): Promise<string> {
  // Read refs before the cache so a newly published preview changes the cache key.
  const { refs, etag } = await work.timing.measure('r2.refs', () => getConfiguredRefsWithEtag(env))
  work.signal.throwIfAborted()
  work.timing.refs = refs.length
  const cacheKey = `${PACKUMENT_OUT_PREFIX}${name}/${etag ?? 'none'}`

  return kvCachedText(
    env,
    cacheKey,
    PACKUMENT_OUT_TTL_S,
    () => assemblePackument(env, name, refs, work),
    work,
  )
}

async function assemblePackument(
  env: Env,
  name: string,
  refs: ConfiguredPreviewRef[],
  work: RequestWork,
): Promise<string> {
  // Fetch independent inputs concurrently. The aggregate needs one R2 read
  // regardless of the number of refs.
  const [base, time, metaIndex] = await Promise.all([
    getNpmPackumentCached(env, name, work),
    getNpmTimeCached(env, name, work),
    work.timing.measure('r2.meta-index', () => readMetaIndex(env, name)),
  ])

  work.signal.throwIfAborted()
  const packument: Record<string, any> = base ?? { name, 'dist-tags': {}, versions: {} }
  packument.name = name
  packument['dist-tags'] ??= {}
  packument.versions ??= {}

  // pnpm requires publish times, which npm's abbreviated packument omits.
  // This map belongs to this request, so adding preview times is safe.
  packument.time = time

  // Fall back to per-version metadata for older publishes or a missing/corrupt
  // aggregate. Isolate ref failures, but let request cancellation propagate.
  work.timing.fallbackReads = refs.filter((ref) => !metaIndex[ref.version]).length
  await work.timing.measure('preview.inject', () =>
    Promise.all(
      refs.map(async (ref) => {
        try {
          const preview = metaIndex[ref.version] ?? (await getPreviewMeta(env, name, ref.version))
          packument.versions[ref.version] = buildVersionMetadata(env, name, ref.version, preview)
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

  // Each PR tag follows its latest published commit present in this packument.
  for (const [prNum, version] of latestVersionByPr(refs, (v) => v in packument.versions)) {
    packument['dist-tags'][`pr-${prNum}`] = version
  }

  work.signal.throwIfAborted()
  return JSON.stringify(packument)
}
