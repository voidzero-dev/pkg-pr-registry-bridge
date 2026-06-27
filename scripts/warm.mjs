#!/usr/bin/env node
// Pre-warm the bridge caches for every configured preview ref.
//
// For each `VITE_PLUS_PREVIEW_REFS` entry and each preview package, this
// fetches the tarball once (which builds and durably stores the rewritten
// tarball + package.json in R2) and then confirms the packument injects the
// synthetic version. After this runs, real installs are served entirely from
// cache, so a package manager's concurrent install never hits the slow,
// failure-prone build path.
//
// Run automatically as part of `pnpm deploy`.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PREVIEW_PACKAGES = ['vite-plus', '@voidzero-dev/vite-plus-core']

function readWrangler() {
  const toml = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8')
  const grab = (key) =>
    (toml.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)) || [])[1] ?? ''
  return { baseUrl: grab('PUBLIC_BASE_URL'), refs: grab('VITE_PLUS_PREVIEW_REFS') }
}

function refToVersion(ref) {
  const commit = ref.match(/^commit\.([0-9a-f]{7,40})$/i)
  if (commit) return `0.0.0-commit.${commit[1]}`
  return null
}

async function getWithRetry(url, opts, attempts = 3) {
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, opts)
      if (res.ok) return res
      lastErr = new Error(`HTTP ${res.status} for ${url}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 1500 * i))
  }
  throw lastErr
}

const { baseUrl: rawBase, refs } = readWrangler()
const base = (process.env.BRIDGE_URL || rawBase || '').replace(/\/+$/, '')
if (!base) {
  console.error('warm: could not determine bridge URL')
  process.exit(1)
}

const versions = refs
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((ref) => {
    const version = refToVersion(ref)
    if (!version) throw new Error(`warm: invalid preview ref "${ref}"`)
    return version
  })

if (versions.length === 0) {
  console.log('warm: no preview refs configured; nothing to warm.')
  process.exit(0)
}

console.log(`warm: ${base}`)
let failed = false

function sha512(buf) {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`
}

for (const version of versions) {
  // Build + cache each tarball (this also stores the rewritten package.json),
  // and remember its actual integrity to cross-check against the packument.
  const tarballIntegrity = {}
  for (const pkg of PREVIEW_PACKAGES) {
    const url = `${base}/tarballs/${pkg}/${version}.tgz`
    try {
      const res = await getWithRetry(url)
      const buf = Buffer.from(await res.arrayBuffer())
      tarballIntegrity[pkg] = sha512(buf)
      console.log(`  ✓ tarball ${pkg}@${version} (${buf.length} bytes)`)
    } catch (err) {
      failed = true
      console.error(`  ✗ tarball ${pkg}@${version}: ${err.message}`)
    }
  }

  // Confirm the packument injects the version, and that any advertised
  // integrity actually matches the served tarball (guards the stale-cache /
  // content-drift class of bug that surfaces as IntegrityCheckFailed).
  for (const pkg of PREVIEW_PACKAGES) {
    const url = `${base}/${pkg.replace('/', '%2F')}`
    try {
      const res = await getWithRetry(url, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
      const packument = await res.json()
      const meta = packument.versions && packument.versions[version]
      if (!meta) {
        failed = true
        console.error(`  ✗ packument ${pkg} is missing ${version}`)
      } else {
        const advertised = meta.dist && meta.dist.integrity
        if (advertised && advertised !== tarballIntegrity[pkg]) {
          failed = true
          console.error(
            `  ✗ integrity mismatch ${pkg}@${version}: packument ${advertised} != served ${tarballIntegrity[pkg]}`,
          )
        } else {
          console.log(`  ✓ packument ${pkg} injects ${version}`)
        }
      }
    } catch (err) {
      failed = true
      console.error(`  ✗ packument ${pkg}: ${err.message}`)
    }
  }
}

process.exit(failed ? 1 : 0)
