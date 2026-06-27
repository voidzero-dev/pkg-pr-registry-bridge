function toHex(buffer: ArrayBuffer): string {
  let out = ''
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let result = 0
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return result === 0
}

/**
 * Verify a GitHub webhook `X-Hub-Signature-256` header (HMAC-SHA256 of the raw
 * body keyed by the shared secret).
 */
export async function verifyGitHubSignature(
  secret: string,
  rawBody: string,
  signatureHeader: string,
): Promise<boolean> {
  if (!signatureHeader.startsWith('sha256=')) return false
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(rawBody),
  )
  return timingSafeEqual(`sha256=${toHex(mac)}`, signatureHeader)
}

export const PKG_PR_NEW_BOT = 'pkg-pr-new[bot]'

const SHA_RE = /@([0-9a-f]{40})\b/gi

/**
 * Extract registrable refs from a pkg.pr.new bot comment on a PR: every
 * distinct full commit sha referenced in the install URLs (`commit.<sha>`).
 * Only immutable commit refs are registered (PR-number refs are not supported).
 * The bot posts this comment only after a build is published, so these refs are
 * known to exist.
 */
export function refsFromBotComment(body: string): string[] {
  const refs = new Set<string>()
  for (const match of body.matchAll(SHA_RE)) {
    refs.add(`commit.${match[1].toLowerCase()}`)
  }
  return [...refs]
}

/** Whether this webhook delivery is a pkg.pr.new bot comment on a PR. */
export function isPkgPrNewComment(
  event: string | undefined,
  payload: any,
): boolean {
  return (
    event === 'issue_comment' &&
    (payload?.action === 'created' || payload?.action === 'edited') &&
    payload?.comment?.user?.login === PKG_PR_NEW_BOT &&
    Boolean(payload?.issue?.pull_request)
  )
}
