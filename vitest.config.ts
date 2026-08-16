import { defineConfig } from 'vite-plus'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  test: {
    projects: [
      {
        plugins: [
          cloudflareTest({
            wrangler: { configPath: './wrangler.test.jsonc' },
            miniflare: {
              // Test overrides for the bindings declared in wrangler.test.jsonc.
              bindings: {
                PUBLIC_BASE_URL: 'https://bridge.example.com',
                ADMIN_TOKEN: 'test-admin-token',
                // OIDC publishing (RFC 0002). The audience is set explicitly
                // rather than derived, mirroring production: staging's
                // PUBLIC_BASE_URL points at prod, so deriving it would make a
                // staging-minted token valid there.
                OIDC_AUDIENCE: 'https://bridge.example.com',
                OIDC_TRUSTED_WORKFLOWS:
                  'voidzero-dev/vite-plus/.github/workflows/publish-preview-register.yml@refs/heads/main',
                OIDC_TRUSTED_REPOSITORY_ID: '778899',
                OIDC_TRUSTED_OWNER_ID: '112233',
              },
            },
          }),
        ],
        test: {
          name: 'worker',
          include: ['test/*.test.ts'],
        },
      },
      {
        // The publish action runs in Node and shells out to `pnpm pack`,
        // which the workers pool cannot; its tests run in a plain Node project.
        test: {
          name: 'action',
          include: ['test/action/*.test.ts'],
        },
      },
    ],
  },
})
