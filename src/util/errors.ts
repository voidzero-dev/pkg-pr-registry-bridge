/**
 * A log-ready description of an error: its stack (which embeds name and
 * message) plus the `cause` chain. `console.warn('...', err)` renders only
 * `String(err)` in the Workers logs, dropping the stack and cause, so warn
 * sites pass this instead. The depth bound keeps a cyclic cause chain from
 * recursing forever.
 */
export function describeError(err: unknown, depth = 0): string {
  if (!(err instanceof Error)) return String(err)
  const own = err.stack ?? `${err.name}: ${err.message}`
  if (err.cause === undefined || depth >= 4) return own
  return `${own}\nCaused by: ${describeError(err.cause, depth + 1)}`
}
