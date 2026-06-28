#!/usr/bin/env node
// Pre-warm the bridge caches for preview refs: for each ref and each package
// (the two preview packages plus the platform binaries in vite-plus's
// optionalDependencies), fetch the tarball once, which builds and durably stores
// the rewritten tarball in R2. After this runs, real installs are served from
// cache and never hit the slow, occasionally-flaky cold build path.
//
// Usage:
//   node scripts/warm.mjs                    # warm the refs in wrangler.toml
//   node scripts/warm.mjs <sha> [<sha>...]   # register each commit, then warm it
//
// Registering a ref needs PKG_PR_BRIDGE_ADMIN_TOKEN (or ADMIN_TOKEN) in the
// environment. Run automatically (no args) as part of `pnpm deploy`.
import { createHash } from 'node:crypto'
import { parseTarGzip } from 'nanotar'
import { readWrangler, refToVersion } from './lib/wrangler.mjs'

const PREVIEW_PACKAGES = ['vite-plus', '@voidzero-dev/vite-plus-core']
const ADMIN_TOKEN =
  process.env.PKG_PR_BRIDGE_ADMIN_TOKEN || process.env.ADMIN_TOKEN || ''

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

function sha512(buf) {
  return `sha512-${createHash('sha512').update(buf).digest('base64')}`
}

/** Normalize a CLI arg (`<sha>` or `commit.<sha>`) to a canonical ref. */
function normalizeRef(input) {
  const m = input.match(/^(?:commit\.)?([0-9a-f]{7,40})$/i)
  return m ? `commit.${m[1].toLowerCase()}` : null
}

async function registerRef(base, ref) {
  if (!ADMIN_TOKEN) {
    throw new Error(
      `registering "${ref}" needs PKG_PR_BRIDGE_ADMIN_TOKEN (or ADMIN_TOKEN) in the environment`,
    )
  }
  const res = await fetch(`${base}/-/refs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ ref }),
  })
  if (!res.ok) {
    throw new Error(
      `register ${ref} failed: HTTP ${res.status} ${await res.text().catch(() => '')}`,
    )
  }
  console.log(`  ✓ registered ${ref}`)
}

/**
 * Fetch a package's version metadata, retrying (with a cache-buster to bypass
 * the edge cache) until the version appears. Configured refs appear at once;
 * a just-registered ref can lag while KV propagates.
 */
async function waitForVersion(base, pkg, version, attempts = 45) {
  const path = pkg.replace('/', '%2F')
  let lastErr
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${base}/${path}?_=${i}.${process.pid}`, {
        headers: { accept: 'application/vnd.npm.install-v1+json' },
      })
      if (res.ok) {
        const packument = await res.json()
        const meta = packument.versions && packument.versions[version]
        if (meta) return meta
        lastErr = new Error(`version ${version} not yet in ${pkg} packument`)
      } else {
        lastErr = new Error(`HTTP ${res.status} for ${pkg} packument`)
      }
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 2000))
  }
  throw lastErr
}

/** The platform-binary package names from a built vite-plus tarball. */
async function platformPackagesFromTarball(buf) {
  const files = await parseTarGzip(new Uint8Array(buf))
  const entry = files.find(
    (f) =>
      (f.name === 'package/package.json' ||
        f.name === './package/package.json') &&
      f.data,
  )
  if (!entry) return []
  const pkg = JSON.parse(new TextDecoder().decode(entry.data))
  return Object.keys(pkg.optionalDependencies || {}).filter((n) =>
    n.startsWith('@voidzero-dev/vite-plus-'),
  )
}

const { baseUrl: rawBase, refs: configuredRefs } = readWrangler()
const base = (process.env.BRIDGE_URL || rawBase || '').replace(/\/+$/, '')
if (!base) {
  console.error('warm: could not determine bridge URL')
  process.exit(1)
}

// CLI args = commits to register then warm; otherwise the configured refs.
const cliArgs = process.argv.slice(2).map((s) => s.trim()).filter(Boolean)
let refStrings
if (cliArgs.length > 0) {
  refStrings = cliArgs.map((a) => {
    const ref = normalizeRef(a)
    if (!ref) {
      console.error(`warm: invalid commit "${a}" (expected a sha or commit.<sha>)`)
      process.exit(1)
    }
    return ref
  })
  console.log(`warm: ${base} (register + warm ${refStrings.join(', ')})`)
  try {
    for (const ref of refStrings) await registerRef(base, ref)
  } catch (err) {
    console.error(`warm: ${err.message}`)
    process.exit(1)
  }
} else {
  refStrings = configuredRefs.split(',').map((s) => s.trim()).filter(Boolean)
  console.log(`warm: ${base}`)
}

const versions = refStrings.map((ref) => {
  const version = refToVersion(ref)
  if (!version) {
    console.error(`warm: invalid preview ref "${ref}"`)
    process.exit(1)
  }
  return version
})

if (versions.length === 0) {
  console.log('warm: no preview refs configured; nothing to warm.')
  process.exit(0)
}

let failed = false

for (const version of versions) {
  // Build + cache each preview-package tarball (this also stores the rewritten
  // package.json), and remember its integrity to cross-check against the
  // packument. Keep the vite-plus tarball to enumerate its platform binaries.
  const tarballIntegrity = {}
  let vitePlusBuf = null
  for (const pkg of PREVIEW_PACKAGES) {
    const url = `${base}/tarballs/${pkg}/${version}.tgz`
    try {
      const res = await getWithRetry(url)
      const buf = Buffer.from(await res.arrayBuffer())
      tarballIntegrity[pkg] = sha512(buf)
      if (pkg === 'vite-plus') vitePlusBuf = buf
      console.log(`  ✓ tarball ${pkg}@${version} (${buf.length} bytes)`)
    } catch (err) {
      failed = true
      console.error(`  ✗ tarball ${pkg}@${version}: ${err.message}`)
    }
  }

  // Confirm the packument injects the version, and that any advertised integrity
  // actually matches the served tarball (guards the stale-cache / content-drift
  // class of bug that surfaces as IntegrityCheckFailed). A just-registered ref
  // is eventually consistent in KV, so retry with a cache-buster.
  for (const pkg of PREVIEW_PACKAGES) {
    try {
      const meta = await waitForVersion(base, pkg, version)
      const advertised = meta.dist && meta.dist.integrity
      if (advertised && tarballIntegrity[pkg] && advertised !== tarballIntegrity[pkg]) {
        failed = true
        console.error(
          `  ✗ integrity mismatch ${pkg}@${version}: packument ${advertised} != served ${tarballIntegrity[pkg]}`,
        )
      } else {
        console.log(`  ✓ packument ${pkg} injects ${version}`)
      }
    } catch (err) {
      failed = true
      console.error(`  ✗ packument ${pkg}: ${err.message}`)
    }
  }

  // Warm the platform binaries (vite-plus's optionalDependencies, read from the
  // tarball we just built so it does not wait on KV propagation). Their first
  // build is heavy and can need a retry, so use extra attempts here rather than
  // on a user's install.
  let platformPkgs = []
  try {
    if (vitePlusBuf) platformPkgs = await platformPackagesFromTarball(vitePlusBuf)
  } catch (err) {
    console.warn(`  ! could not enumerate platform binaries: ${err.message}`)
  }
  for (const pkg of platformPkgs) {
    const url = `${base}/tarballs/${pkg}/${version}.tgz`
    try {
      const r = await getWithRetry(url, undefined, 6)
      const buf = Buffer.from(await r.arrayBuffer())
      console.log(`  ✓ platform ${pkg}@${version} (${buf.length} bytes)`)
    } catch (err) {
      failed = true
      console.error(`  ✗ platform ${pkg}@${version}: ${err.message}`)
    }
  }
}

process.exit(failed ? 1 : 0)
