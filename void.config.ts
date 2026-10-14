import { readFileSync } from 'node:fs'
import { URL } from 'node:url'
import { parseEnv } from 'node:util'
import { defineConfig } from 'void/config'

const settings = parseEnv(readFileSync(new URL('./config/production.env', import.meta.url), 'utf8'))
const vars: Record<string, string> = {}
for (const [name, value] of Object.entries(settings)) {
  if (value !== undefined) vars[name] = value
}

export default defineConfig({
  target: 'cloudflare',
  inference: {
    appType: 'void',
    bindings: {
      storage: true,
      kv: true,
    },
  },
  worker: {
    compatibility_date: '2026-02-24',
    // Public settings travel with the deployment. Void uses .env overrides
    // only during local development; credentials stay in the remote store.
    vars,
  },
})
