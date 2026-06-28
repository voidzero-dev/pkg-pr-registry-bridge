#!/usr/bin/env node
// Publish preview refs to the bridge by running the publish action for each one
// (build + hash + upload the artifacts in Node, then register the ref). This is
// the same code path vite-plus's CI uses; here it pre-populates the configured
// static refs as part of `pnpm deploy`.
//
// Usage:
//   node scripts/warm.mjs                    # publish the refs in wrangler.toml
//   node scripts/warm.mjs <sha> [<sha>...]   # publish each commit
//
// Needs PKG_PR_BRIDGE_ADMIN_TOKEN (or ADMIN_TOKEN) in the environment.
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readWrangler, normalizeSha } from './lib/wrangler.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ACTION = path.join(root, '.github/actions/publish-preview/dist/index.mjs')
const ADMIN_TOKEN =
  process.env.PKG_PR_BRIDGE_ADMIN_TOKEN || process.env.ADMIN_TOKEN || ''

function publish(sha, bridge) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ACTION], {
      stdio: 'inherit',
      env: {
        ...process.env,
        INPUT_SHA: sha,
        'INPUT_BRIDGE-URL': bridge,
        'INPUT_ADMIN-TOKEN': ADMIN_TOKEN,
      },
    })
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`publish ${sha} exited ${code}`)),
    )
  })
}

const { baseUrl, refs } = readWrangler()
const bridge = (process.env.BRIDGE_URL || baseUrl || '').replace(/\/+$/, '')
if (!bridge) {
  console.error('warm: could not determine bridge URL')
  process.exit(1)
}
if (!ADMIN_TOKEN) {
  console.error('warm: needs PKG_PR_BRIDGE_ADMIN_TOKEN (or ADMIN_TOKEN) in the environment')
  process.exit(1)
}

const cliArgs = process.argv.slice(2).map((s) => s.trim()).filter(Boolean)
const source = cliArgs.length > 0 ? cliArgs : refs.split(',')
const shas = source.map((s) => s.trim()).filter(Boolean).map((raw) => {
  const sha = normalizeSha(raw)
  if (!sha) {
    console.error(`warm: invalid commit "${raw}" (expected a sha or commit.<sha>)`)
    process.exit(1)
  }
  return sha
})

if (shas.length === 0) {
  console.log('warm: no preview refs configured; nothing to publish.')
  process.exit(0)
}

console.log(`warm: ${bridge} (publish ${shas.join(', ')})`)
let failed = false
for (const sha of shas) {
  try {
    await publish(sha, bridge)
  } catch (err) {
    failed = true
    console.error(`warm: ${err.message}`)
  }
}
process.exit(failed ? 1 : 0)
