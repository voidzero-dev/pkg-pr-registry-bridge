#!/usr/bin/env node
// End-to-end validation against a LIVE deployment of the bridge.
//
// Creates a throwaway Bun project pointed at the bridge, runs `bun install`
// with the npm-alias override from the design doc, and asserts that the
// installed packages resolved to the synthetic preview version (which only the
// bridge can serve). Intended to run after every deploy (`pnpm deploy`).
//
// Config (all optional):
//   BRIDGE_URL         override the bridge origin (default: PUBLIC_BASE_URL from .env)
//   BRIDGE_E2E_REF     preview ref to test, e.g. `commit.<sha>` (default: the
//                      first ref the bridge currently lists at /-/refs)
//   BRIDGE_E2E_VERSION explicit synthetic version, e.g. `0.0.0-commit.<sha>`
//                      (overrides BRIDGE_E2E_REF)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readConfig, refToVersion } from './lib/config.mjs'

async function waitForHealth(base) {
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      const res = await fetch(`${base}/_health`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 3000))
  }
  throw new Error(`bridge health check never passed at ${base}/_health`)
}

// The synthetic version to validate: an explicit override, else the first ref
// the live bridge currently lists. Preview refs are registered at runtime (CI /
// admin), not static config, so the test discovers one from the deployment
// rather than reading it from `.env`.
async function resolveVersion(base) {
  if (process.env.BRIDGE_E2E_VERSION) return process.env.BRIDGE_E2E_VERSION
  if (process.env.BRIDGE_E2E_REF) return refToVersion(process.env.BRIDGE_E2E_REF)
  try {
    const res = await fetch(`${base}/-/refs`)
    const { refs } = await res.json()
    const first = Array.isArray(refs) ? refs[0] : null
    return first?.version ?? (first?.ref ? refToVersion(first.ref) : null)
  } catch {
    return null
  }
}

const config = readConfig()
const bridgeUrl = (process.env.BRIDGE_URL || config.baseUrl || '').replace(/\/+$/, '')

if (!bridgeUrl) {
  console.error('e2e: could not determine bridge URL (set BRIDGE_URL)')
  process.exit(1)
}

try {
  execFileSync('bun', ['--version'], { stdio: 'ignore' })
} catch {
  console.error('e2e: `bun` is required but was not found on PATH')
  process.exit(1)
}

await waitForHealth(bridgeUrl)

const version = await resolveVersion(bridgeUrl)
if (!version) {
  console.log('e2e: no preview ref available on the bridge; nothing to validate, skipping.')
  process.exit(0)
}

console.log(`e2e: validating ${version} via ${bridgeUrl}`)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-e2e-'))
let exitCode = 0
try {
  fs.writeFileSync(
    path.join(dir, 'bunfig.toml'),
    // networkConcurrency works around a bun HTTP/2 bug on large dependency
    // graphs (see README); it mirrors the recommended consumer config.
    `[install]\nregistry = "${bridgeUrl}/"\nnetworkConcurrency = 8\n`,
  )
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name: 'bridge-e2e',
        version: '0.0.0',
        devDependencies: {
          vite: `npm:@voidzero-dev/vite-plus-core@${version}`,
          '@voidzero-dev/vite-plus-core': version,
          'vite-plus': version,
        },
        overrides: {
          vite: `npm:@voidzero-dev/vite-plus-core@${version}`,
        },
      },
      null,
      2,
    )}\n`,
  )

  // Fresh cache so the install genuinely exercises the deployed bridge rather
  // than a previously cached tarball.
  const bunEnv = {
    ...process.env,
    BUN_INSTALL_CACHE_DIR: path.join(dir, '.bun-cache'),
  }
  // A parent process manager (pnpm/npm/yarn) may inject a registry override
  // into the environment, e.g. from PNPM_CONFIG_REGISTRY. bun honours
  // npm_config_registry over bunfig.toml, which would bypass the bridge and
  // hit the upstream registry directly. Strip these so the bunfig registry
  // (the bridge) is what gets exercised.
  for (const key of Object.keys(bunEnv)) {
    const lower = key.toLowerCase()
    if (
      lower === 'npm_config_registry' ||
      lower === 'pnpm_config_registry' ||
      lower === 'bun_config_registry' ||
      /^(npm|pnpm)_config_@[^:]+:registry$/.test(lower)
    ) {
      delete bunEnv[key]
    }
  }

  let installed = false
  try {
    execFileSync('bun', ['install', '--no-summary'], {
      cwd: dir,
      stdio: 'inherit',
      timeout: 300_000,
      env: bunEnv,
    })
    installed = true
  } catch {
    console.error('e2e: `bun install` failed against the bridge')
    exitCode = 1
  }

  if (installed) {
    const expectations = [
      ['vite', '@voidzero-dev/vite-plus-core', version],
      ['vite-plus', 'vite-plus', version],
      ['@voidzero-dev/vite-plus-core', '@voidzero-dev/vite-plus-core', version],
    ]
    const failures = []
    for (const [name, expectedName, expectedVersion] of expectations) {
      const pj = path.join(dir, 'node_modules', name, 'package.json')
      if (!fs.existsSync(pj)) {
        failures.push(`node_modules/${name} was not installed`)
        continue
      }
      const pkg = JSON.parse(fs.readFileSync(pj, 'utf8'))
      if (pkg.name !== expectedName) {
        failures.push(`node_modules/${name}: name ${pkg.name} !== ${expectedName}`)
      }
      if (pkg.version !== expectedVersion) {
        failures.push(`node_modules/${name}: version ${pkg.version} !== ${expectedVersion}`)
      }
      if (pkg.name === expectedName && pkg.version === expectedVersion) {
        console.log(`  ✓ node_modules/${name} -> ${pkg.name}@${pkg.version}`)
      }
    }

    // Supplementary signal: the preview tarballs should be served by the
    // bridge. Soft check (warn only) to stay resilient to lockfile format.
    const lock = path.join(dir, 'bun.lock')
    if (fs.existsSync(lock)) {
      const host = new URL(bridgeUrl).host
      if (fs.readFileSync(lock, 'utf8').includes(host)) {
        console.log(`  ✓ bun.lock references the bridge host (${host})`)
      } else {
        console.warn(`  ! bun.lock does not reference ${host}`)
      }
    }

    if (failures.length > 0) {
      console.error('e2e FAILED:')
      for (const f of failures) console.error(`  ✗ ${f}`)
      exitCode = 1
    } else {
      console.log('e2e PASSED')
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

process.exit(exitCode)
