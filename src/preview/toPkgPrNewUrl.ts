import type { Env } from '../config'
import { parsePreviewVersion } from './parsePreviewVersion'

type UpstreamEnv = Pick<Env, 'PKG_PR_NEW_BASE' | 'PREVIEW_OWNER' | 'PREVIEW_REPO'>

/**
 * Map a package name + synthetic version to the pkg.pr.new upstream URL.
 *
 *   @voidzero-dev/vite-plus-core @ 0.0.0-commit.a832a55
 *     -> {base}/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-core@a832a55
 *   vite-plus @ 0.0.0-commit.a832a55
 *     -> {base}/voidzero-dev/vite-plus/vite-plus@a832a55
 *
 * Owner/repo come from env and are never selected by request input.
 */
export function toPkgPrNewUrl(
  env: UpstreamEnv,
  packageName: string,
  version: string,
): string | null {
  const preview = parsePreviewVersion(version)
  if (!preview) return null
  return (
    `${env.PKG_PR_NEW_BASE}/${env.PREVIEW_OWNER}/${env.PREVIEW_REPO}` +
    `/${packageName}@${preview.ref}`
  )
}
