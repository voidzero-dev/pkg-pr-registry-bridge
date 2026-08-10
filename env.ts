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
  // GitHub Actions OIDC publishing (RFC 0002). NOT secrets: all four hold
  // public identifiers, and the verification key is GitHub's public JWKS, so
  // they live in `.env.production` rather than `void secret put`.
  //
  // Optional as a group: leaving all four unset disables the OIDC path and
  // leaves admin-token publishing untouched. Setting only SOME of them is
  // rejected at request time, so a half-configured deploy fails loudly instead
  // of silently refusing every token.
  OIDC_AUDIENCE: string().optional(),
  OIDC_TRUSTED_WORKFLOWS: string().optional(),
  OIDC_TRUSTED_REPOSITORY_ID: string().optional(),
  OIDC_TRUSTED_OWNER_ID: string().optional(),
})
