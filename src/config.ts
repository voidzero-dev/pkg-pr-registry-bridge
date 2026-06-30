/**
 * Worker environment bindings.
 *
 * Configuration that the source design read from `process.env` is delivered
 * here as Cloudflare Worker bindings (`[vars]`, the R2 bucket, secrets).
 */
export interface Env {
  /** Public origin of this bridge, used to build `dist.tarball` URLs. */
  PUBLIC_BASE_URL: string
  /** npm registry to fall back to for everything not synthesized. */
  NPM_REGISTRY: string
  /** pkg.pr.new base URL. */
  PKG_PR_NEW_BASE: string
  /** Fixed upstream owner; never selected by request input. */
  PREVIEW_OWNER: string
  /** Fixed upstream repo; never selected by request input. */
  PREVIEW_REPO: string
  /**
   * Comma-separated allowlist of packages the tarball endpoint may serve and
   * whose pkg.pr.new dependency URLs are routed through the bridge. Entries are
   * exact names or `prefix*` patterns, e.g.
   * `vite-plus,@voidzero-dev/vite-plus-*`. Configurable so new workspace
   * packages need no code change.
   */
  WORKSPACE_PACKAGES: string
  /** Max upstream tarball size in bytes (string-typed var). */
  MAX_TARBALL_BYTES: string
  /**
   * Durable store for preview tarballs and their metadata. Artifacts are built
   * and hashed in CI (the publish action) and uploaded here; the Worker only
   * serves them, so it never decompresses or hashes a large payload itself.
   * Also holds the runtime-registered refs index (see getConfiguredRefs).
   */
  STORAGE: R2Bucket
  /**
   * KV namespace caching npm's per-version `time` map (small, TTL'd). Used
   * instead of the Cache API, which the Void runtime forbids.
   */
  KV: KVNamespace
  /** Bearer token guarding the admin endpoints (`/-/refs`, `/-/purge`, etc.). */
  ADMIN_TOKEN?: string
}

const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024

/** Resolve the configured max tarball size, with a safe default. */
export function maxTarballBytes(env: Env): number {
  const n = Number(env.MAX_TARBALL_BYTES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TARBALL_BYTES
}
