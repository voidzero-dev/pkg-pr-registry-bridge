/**
 * Derive a platform binary's `os`/`cpu`/`libc` from its package name.
 *
 * The platform binaries follow the `<...>-<os>-<cpu>[-<libc>]` convention
 * (e.g. `@voidzero-dev/vite-plus-darwin-arm64`,
 * `@voidzero-dev/vite-plus-linux-x64-musl`). A package manager reads these
 * fields from the packument to install only the binary matching the current
 * platform, so the bridge must advertise them.
 *
 * The authoritative values come from the binary's own package.json, which CI
 * uploads with the rest of the meta. This name-derived fallback lets the
 * packument stay correct for a ref that was registered without a CI publish,
 * with no need to download and decompress the (tens-of-MB) tarball in-Worker.
 */
export interface PlatformInfo {
  os: string[]
  cpu: string[]
  libc?: string[]
}

// npm's `libc` field uses `glibc`/`musl`; the binary names use `gnu`/`musl`.
const LIBC: Record<string, string> = { gnu: 'glibc', musl: 'musl' }

const SUFFIX =
  /-(darwin|linux|win32|freebsd|android)-(x64|arm64|ia32|arm)(?:-(gnu|musl|msvc|eabihf|eabi))?$/

/**
 * Parse os/cpu/libc from a platform-binary name, or null if it doesn't match.
 * Fails closed: an unrecognized triple yields null, so the packument entry gets
 * no os/cpu and the package manager won't filter on platform, rather than a
 * wrong guess. This is only the pre-publish fallback; CI uploads the exact
 * values from each binary's own package.json.
 */
export function platformInfoFromName(name: string): PlatformInfo | null {
  const m = SUFFIX.exec(name)
  if (!m) return null
  const [, os, cpu, abi] = m
  const info: PlatformInfo = { os: [os], cpu: [cpu] }
  if (abi && LIBC[abi]) info.libc = [LIBC[abi]]
  return info
}
