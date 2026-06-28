import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.test.jsonc' },
      miniflare: {
        // Test overrides for the bindings declared in wrangler.test.jsonc.
        bindings: {
          PUBLIC_BASE_URL: 'https://bridge.example.com',
          VITE_PLUS_PREVIEW_REFS: 'commit.a832a55',
          ADMIN_TOKEN: 'test-admin-token',
        },
      },
    }),
  ],
})
