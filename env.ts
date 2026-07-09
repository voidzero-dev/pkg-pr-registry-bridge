import { defineEnv, string } from 'void/env'

// Typed, validated worker configuration. Non-secret values live in `.env`
// (committed) and `.env.production` (committed); secrets are uploaded with
// `void secret put` for production and read from `.env.local` in dev.
export default defineEnv({
  // Public origin of this bridge, baked into generated `dist.tarball` URLs.
  // Must match the deployed route. Overridden per environment.
  PUBLIC_BASE_URL: string(),
  // npm registry to fall back to for everything not synthesized.
  NPM_REGISTRY: string(),
  // Fixed upstream owner/repo; never selected by request input.
  PREVIEW_OWNER: string(),
  PREVIEW_REPO: string(),
  // Allowlist of packages the bridge serves/routes (exact names or `prefix*`).
  WORKSPACE_PACKAGES: string(),
  // Bearer token guarding the admin endpoints. Secret: `void secret put ADMIN_TOKEN`.
  ADMIN_TOKEN: string().secret().optional(),
})
