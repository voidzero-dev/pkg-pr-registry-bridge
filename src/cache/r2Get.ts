import type { Env } from '../config'
import { describeError } from '../util/errors'

/**
 * R2's transient InternalError: "We encountered an internal error. Please try
 * again. (10001)". workerd surfaces it as a plain Error with the code only in
 * the message text (no structured code field), so match on that.
 */
export function isR2TransientError(err: unknown): boolean {
  return err instanceof Error && err.message.includes('(10001)')
}

/**
 * `STORAGE.get` with one retry on R2's transient InternalError, whose message
 * itself says to try again. Seen live: a packument rebuild's meta read hit a
 * 10001 blip, the ref was skipped, and the degraded packument was cached for
 * PACKUMENT_OUT_TTL_S, failing installs of that version. Any other error
 * propagates untouched. A second 10001 is rethrown with the object key
 * attached (the runtime error names only the operation) and the original as
 * `cause`, so the upstream warn/error log identifies the failing object.
 */
export async function r2Get(
  env: Env,
  key: string,
): Promise<R2ObjectBody | null> {
  try {
    return await env.STORAGE.get(key)
  } catch (err) {
    if (!isR2TransientError(err)) throw err
    console.warn(
      `R2 get ${key} hit a transient internal error, retrying once:`,
      describeError(err),
    )
    try {
      return await env.STORAGE.get(key)
    } catch (retryErr) {
      const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
      throw new Error(`R2 get ${key} failed after retry: ${msg}`, {
        cause: retryErr,
      })
    }
  }
}
