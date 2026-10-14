// Check the emitted Worker configuration, not just the source config loader.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const config = JSON.parse(
  readFileSync(new URL('../dist/ssr/wrangler.json', import.meta.url), 'utf8'),
)
const expected = parseEnv(
  readFileSync(new URL('../config/production.env', import.meta.url), 'utf8'),
)

assert.ok(Object.keys(expected).length > 0, 'Public production settings must not be empty')
for (const [name, value] of Object.entries(expected)) {
  assert.equal(config.vars?.[name], value, `${name} must match config/production.env`)
}
assert.equal('ADMIN_TOKEN' in (config.vars ?? {}), false, 'ADMIN_TOKEN must remain a secret')
console.log('Built Worker includes the public production settings without ADMIN_TOKEN')
