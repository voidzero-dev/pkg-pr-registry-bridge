/**
 * Worker environment bindings.
 *
 * Configuration that the source design read from `process.env` is delivered
 * here as Cloudflare Worker bindings (`[vars]`, R2/KV bindings, secrets).
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
  /** Comma-separated preview refs to inject, e.g. `pr.1891,commit.a832a55`. */
  VITE_PLUS_PREVIEW_REFS: string
  /** Max upstream tarball size in bytes (string-typed var). */
  MAX_TARBALL_BYTES: string
  /** Durable cache for generated tarballs and rewritten package.json. */
  TARBALL_CACHE: R2Bucket
  /** Dynamic preview-ref registry (refs added at runtime, no redeploy). */
  PREVIEW_REFS?: KVNamespace
  /** Token for GitHub PR/commit existence checks (secret). */
  GITHUB_TOKEN?: string
  /** Bearer token guarding the admin endpoints (`/-/refs`, `/-/purge`). */
  ADMIN_TOKEN?: string
  /** Shared secret for verifying GitHub webhook payloads (`/-/webhook`). */
  GITHUB_WEBHOOK_SECRET?: string
}

const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024

/** Resolve the configured max tarball size, with a safe default. */
export function maxTarballBytes(env: Env): number {
  const n = Number(env.MAX_TARBALL_BYTES)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TARBALL_BYTES
}
