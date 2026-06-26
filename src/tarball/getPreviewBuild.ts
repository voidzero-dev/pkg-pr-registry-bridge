import type { Env } from '../config'
import { maxTarballBytes } from '../config'
import { HttpError } from '../httpError'
import { parsePreviewVersion } from '../preview/parsePreviewVersion'
import { toPkgPrNewUrl } from '../preview/toPkgPrNewUrl'
import { metaKey, tarballKey } from '../cache/r2Cache'
import { buildPreviewTarball, type PreviewBuild } from './buildPreviewTarball'
import { fetchUpstreamTarball } from './fetchUpstreamTarball'

/** Minimal slice of ExecutionContext used to defer cache writes. */
interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void
}

/**
 * Get a preview build (generated tarball + rewritten package.json), served
 * from R2 when present and generated from pkg.pr.new on a miss. R2 writes are
 * scheduled with `waitUntil` so they never add latency to the response.
 *
 * R2 is the durable origin cache: a cold edge does not re-download and
 * re-rewrite from pkg.pr.new. Both the packument and tarball endpoints share
 * this single code path, so the upstream tarball is fetched at most once per
 * (name, version).
 */
export async function getPreviewBuild(
  env: Env,
  ctx: WaitUntil,
  name: string,
  version: string,
): Promise<PreviewBuild> {
  const tKey = tarballKey(name, version)
  const mKey = metaKey(name, version)

  const [tarObj, metaObj] = await Promise.all([
    env.TARBALL_CACHE.get(tKey),
    env.TARBALL_CACHE.get(mKey),
  ])
  if (tarObj && metaObj) {
    const [buf, json] = await Promise.all([
      tarObj.arrayBuffer(),
      metaObj.json<Record<string, any>>(),
    ])
    return { tarball: new Uint8Array(buf), packageJson: json }
  }

  const url = toPkgPrNewUrl(env, name, version)
  if (!url) throw new HttpError(400, `Invalid preview version: ${version}`)

  const upstream = await fetchUpstreamTarball(url, maxTarballBytes(env))
  const build = await buildPreviewTarball(upstream, name, version)

  const immutable = parsePreviewVersion(version)?.type === 'commit'
  const cacheControl = immutable
    ? 'public, max-age=31536000, immutable'
    : 'public, max-age=300'

  ctx.waitUntil(
    Promise.all([
      env.TARBALL_CACHE.put(tKey, build.tarball, {
        httpMetadata: { contentType: 'application/gzip', cacheControl },
      }),
      env.TARBALL_CACHE.put(mKey, JSON.stringify(build.packageJson), {
        httpMetadata: { contentType: 'application/json', cacheControl },
      }),
    ]).catch((err) => {
      console.warn(`Failed to persist preview build ${name}@${version}:`, err)
    }),
  )

  return build
}
