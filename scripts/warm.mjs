#!/usr/bin/env node
// Publish one preview ref to the bridge by running the publish action (pack +
// rewrite + hash + upload in Node, then register the ref). This is the same
// code path vite-plus's CI uses; here it's a manual helper to seed or refresh
// a specific commit, e.g. for incident recovery (refs are otherwise registered
// dynamically by CI, so a normal deploy needs no warming).
//
// The action packs LOCAL package directories (it does not download from
// pkg.pr.new), so this needs a vite-plus checkout at that exact commit, built
// the way the publish workflow builds it: `pnpm install`, dist/binaries in
// place, and `publish-native-addons.ts --mode pkg-pr-new` run. One sha per
// invocation, since a checkout holds one commit's artifacts.
//
// Usage:
//   node scripts/warm.mjs --repo <vite-plus-checkout> [--packages "<list>"] <sha>
//
// Needs PKG_PR_BRIDGE_ADMIN_TOKEN (or ADMIN_TOKEN) in the environment.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readConfig, normalizeSha } from './lib/config.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ACTION = path.join(root, '.github/actions/publish-preview/dist/index.mjs')
const ADMIN_TOKEN =
  process.env.PKG_PR_BRIDGE_ADMIN_TOKEN || process.env.ADMIN_TOKEN || ''

// Mirrors the directories vite-plus's publish workflow passes to the action.
const DEFAULT_PACKAGES =
  'packages/cli,packages/core,packages/prompts,packages/cli/npm/*,packages/cli/cli-npm/*'

function publish(sha, bridge, repo, packages) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ACTION], {
      stdio: 'inherit',
      cwd: repo,
      env: {
        ...process.env,
        INPUT_SHA: sha,
        INPUT_PACKAGES: packages,
        'INPUT_BRIDGE-URL': bridge,
        'INPUT_ADMIN-TOKEN': ADMIN_TOKEN,
      },
    })
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`publish ${sha} exited ${code}`)),
    )
  })
}

const { baseUrl } = readConfig()
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
let repo = ''
let packages = DEFAULT_PACKAGES
const positional = []
for (let i = 0; i < cliArgs.length; i++) {
  if (cliArgs[i] === '--repo') repo = cliArgs[++i] ?? ''
  else if (cliArgs[i] === '--packages') packages = cliArgs[++i] ?? ''
  else positional.push(cliArgs[i])
}

if (positional.length === 0) {
  console.log('warm: no commit sha given; nothing to publish (refs register dynamically).')
  process.exit(0)
}
if (positional.length > 1) {
  console.error('warm: one sha per run (a checkout holds one commit\'s artifacts)')
  process.exit(1)
}
const sha = normalizeSha(positional[0])
if (!sha) {
  console.error(`warm: invalid commit "${positional[0]}" (expected a sha or commit.<sha>)`)
  process.exit(1)
}
if (!repo || !fs.existsSync(path.join(repo, 'package.json'))) {
  console.error('warm: --repo must point at a built vite-plus checkout at that commit')
  process.exit(1)
}

console.log(`warm: ${bridge} (publish ${sha} from ${repo})`)
try {
  await publish(sha, bridge, path.resolve(repo), packages)
} catch (err) {
  console.error(`warm: ${err.message}`)
  process.exit(1)
}
