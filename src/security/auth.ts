import { HttpError } from '../httpError'
import { timingSafeEqual } from './timingSafeEqual'

interface AuthInput {
  env: { ADMIN_TOKEN?: string }
  authorization: string | undefined
}

/**
 * Guard the admin endpoints. Requires `Authorization: Bearer <ADMIN_TOKEN>`.
 * Returns 503 when no admin token is configured (admin disabled), 401 otherwise.
 */
export function requireAdmin({ env, authorization }: AuthInput): void {
  if (!env.ADMIN_TOKEN) {
    throw new HttpError(503, 'Admin endpoints are not configured')
  }
  const provided = (authorization ?? '').replace(/^Bearer\s+/i, '')
  if (!provided || !timingSafeEqual(provided, env.ADMIN_TOKEN)) {
    throw new HttpError(401, 'Unauthorized')
  }
}
