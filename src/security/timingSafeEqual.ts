/**
 * Constant-time string comparison. The loop runs over the full length and never
 * short-circuits, so the time taken does not leak how many leading characters
 * matched (length mismatch returns early, which is not secret).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}
