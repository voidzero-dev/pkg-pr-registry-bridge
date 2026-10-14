// Apply the committed public settings before deployment. `void secret sync`
// prompts even in CI; `secret put` accepts values on stdin without a prompt.
// Only configured keys are written, preserving secrets such as ADMIN_TOKEN.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

const project = process.argv[2]
if (!project || process.argv.length !== 3) {
  throw new Error('Usage: node scripts/sync-config.mjs <project>')
}
if (!process.env.VOID_TOKEN) {
  throw new Error(
    'VOID_TOKEN is required to sync configuration; deployment OIDC cannot write secrets',
  )
}

const settings = Object.entries(
  parseEnv(readFileSync(new URL('../config/production.env', import.meta.url), 'utf8')),
)
if (settings.length === 0) throw new Error('config/production.env contains no settings')

for (const [name, value] of settings) {
  const result = spawnSync('vp', ['exec', 'void', 'secret', 'put', name, '--project', project], {
    input: value,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Failed to sync ${name} to ${project}`)
  }
}

console.log(`Synced ${settings.length} settings to ${project}`)
