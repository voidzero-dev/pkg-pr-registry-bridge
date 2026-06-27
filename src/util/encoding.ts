/** Hex-encode an ArrayBuffer (lower-case, zero-padded). */
export function toHex(buffer: ArrayBuffer): string {
  let out = ''
  for (const byte of new Uint8Array(buffer)) {
    out += byte.toString(16).padStart(2, '0')
  }
  return out
}

/** Base64-encode an ArrayBuffer. */
export function toBase64(buffer: ArrayBuffer): string {
  let binary = ''
  for (const byte of new Uint8Array(buffer)) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}
