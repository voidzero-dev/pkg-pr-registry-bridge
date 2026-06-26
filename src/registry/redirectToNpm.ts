import type { Env } from '../config'

/**
 * Redirect everything the bridge does not synthesize straight to the npm
 * registry.
 *
 * A 302 lets the package manager fetch packuments and tarballs directly from
 * npm's CDN, so the Worker is never in the data path for the hundreds of normal
 * packages a typical install pulls. That keeps the Worker lightweight (no
 * proxied bandwidth/CPU) and lets npm serve what it serves best.
 */
export function redirectToNpm(env: Env, req: Request): Response {
  const url = new URL(req.url)
  const target = `${env.NPM_REGISTRY}${url.pathname}${url.search}`
  return Response.redirect(target, 302)
}
