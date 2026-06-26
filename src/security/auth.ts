import { HttpError } from '../httpError'

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

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
