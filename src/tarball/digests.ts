function toHex(buffer: ArrayBuffer): string {
  let out = ''
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

function toBase64(buffer: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export interface Digests {
  /** SHA-1 hex, for `dist.shasum`. */
  shasum: string
  /** SHA-512 Subresource Integrity string, for `dist.integrity`. */
  integrity: string
}

/**
 * Compute npm dist integrity values from the generated tarball bytes. These are
 * computed from the bytes we actually serve (and store in R2), so they always
 * match. `CompressionStream` gzip output is deterministic, so every region
 * computes the same values for the same input.
 */
export async function computeDigests(data: Uint8Array): Promise<Digests> {
  const [sha1, sha512] = await Promise.all([
    crypto.subtle.digest('SHA-1', data),
    crypto.subtle.digest('SHA-512', data),
  ])
  return { shasum: toHex(sha1), integrity: `sha512-${toBase64(sha512)}` }
}
