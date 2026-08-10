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
  /** Fixed upstream owner; never selected by request input. */
  PREVIEW_OWNER: string
  /** Fixed upstream repo; never selected by request input. */
  PREVIEW_REPO: string
  /**
   * Comma-separated allowlist of packages the tarball endpoint may serve.
   * Entries are exact names or `prefix*` patterns, e.g.
   * `vite-plus,@voidzero-dev/vite-plus-*`. Configurable so new workspace
   * packages need no code change.
   */
  WORKSPACE_PACKAGES: string
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
  /**
   * Audience required in GitHub Actions OIDC tokens (RFC 0002). No default:
   * every environment sets its own, and an unset value disables the OIDC path
   * rather than falling back to another binding. Deliberately NOT derived from
   * PUBLIC_BASE_URL, which staging points at production, so a fallback would
   * make a staging-minted token valid against production.
   */
  OIDC_AUDIENCE?: string
  /**
   * Comma-separated allowlist of exact `workflow_ref` values permitted to
   * publish, e.g.
   * `voidzero-dev/vite-plus/.github/workflows/publish-preview-register.yml@refs/heads/main`.
   */
  OIDC_TRUSTED_WORKFLOWS?: string
  /**
   * Immutable GitHub numeric ids the token must carry. `workflow_ref` embeds a
   * repository NAME, and names can be renamed, transferred, or released and
   * reclaimed; these anchor trust to the repository itself. Read them with:
   *   gh api repos/<owner>/<repo> --jq '{repo: .id, owner: .owner.id}'
   * Required whenever OIDC_TRUSTED_WORKFLOWS is set; a partial OIDC config is
   * rejected at request time rather than silently disabling the path.
   */
  OIDC_TRUSTED_REPOSITORY_ID?: string
  OIDC_TRUSTED_OWNER_ID?: string
}
