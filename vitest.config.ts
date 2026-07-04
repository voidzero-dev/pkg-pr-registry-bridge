import { defineConfig } from 'vitest/config'
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
