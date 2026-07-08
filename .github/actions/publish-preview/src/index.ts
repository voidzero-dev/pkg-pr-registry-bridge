/**
 * GitHub Action: pack a commit's locally built packages and publish them to
 * the registry bridge.
 *
 * Runs in the same CI job that assembled the build artifacts (the exact
 * directories pkg.pr.new publishes from), so the bridge does not depend on a
 * pkg.pr.new upload -> download round-trip. Each directory is packed with
 * `pnpm pack` (resolving workspace:/catalog: specs; run `pnpm install`
 * first), then rewritten, re-packed and hashed with the Worker's own modules,
 * so CI's artifacts are exactly what the Worker would describe. This also
 * runs the CPU/memory-heavy work (rewrite, re-pack, hash) in CI, where there
 * is no per-invocation limit, so the Cloudflare Worker only ever streams
 * bytes.
 *
 * Every package is rewritten to the synthetic commit version, and deps
 * between packages of the same batch are pinned to it (the coherence
 * pkg.pr.new's URL rewriting used to provide). The version rewrite matters
 * even for the platform binaries: pnpm's `strict-store-pkg-content-check`
 * rejects a tarball whose package.json version differs from the version it
 * resolved.
 */
import { relative } from 'node:path'
import { buildPreviewTarball } from '../../../../src/tarball/buildPreviewTarball'
import { parseConfiguredPreviewRefs } from '../../../../src/preview/parseConfiguredPreviewRefs'
import type { RewriteEnv } from '../../../../src/tarball/rewritePackageJson'
import {
  assertValidBatch,
  expandPackageDirs,
  packDirectory,
  parsePackagesInput,
  readManifest,
} from './localPack'

// The vite-plus layout, overridable via the `packages` input. Lives here (not
// action.yml) so direct invocations of the bundle (scripts/warm.mjs) get the
// same default.
const DEFAULT_PACKAGES =
  'packages/cli,packages/core,packages/prompts,packages/cli/npm/*,packages/cli/cli-npm/*'

function input(name: string, required = false): string {
  const value = (process.env[`INPUT_${name.toUpperCase()}`] ?? '').trim()
  if (required && !value) throw new Error(`missing required input: ${name}`)
  return value
}

async function withRetry<T>(label: string, fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastErr: unknown
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < attempts) await new Promise((r) => setTimeout(r, 1000 * i))
    }
  }
  throw new Error(`${label} failed after ${attempts} attempts: ${lastErr}`)
}

// Per-attempt fetch deadlines. Without one, a hung connection stalls up to
// undici's ~5-minute defaults, and 4 retry attempts across ~11 packages can
// zombie a publish for tens of minutes (the 2026-07-02 incident's cancelled
// attempt ran 21 minutes mid-publish). Bounding each attempt keeps retries
// snappy and the whole run inside a predictable window. Uploads move up to
// ~19 MB per request; the publish/register calls are small JSON POSTs.
const TRANSFER_TIMEOUT_MS = 120_000
const PUBLISH_TIMEOUT_MS = 30_000

async function uploadTarball(
  bridge: string,
  token: string,
  name: string,
  version: string,
  bytes: Uint8Array,
  shasum: string,
): Promise<void> {
  await withRetry(`upload ${name}`, async () => {
    // Content-addressed path: the shasum (sha1 of these exact bytes) is in the
    // key, so a republish with different bytes lands at a different URL and the
    // packument's shasum always selects the matching bytes.
    const res = await fetch(`${bridge}/-/tarball/${name}/${version}/${shasum}.tgz`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' },
      body: bytes,
      signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  })
}

async function main(): Promise<void> {
  // Accept a bare sha or `commit.<sha>`; reuse the Worker's parser to validate it
  // and produce the canonical ref + synthetic version (one source of truth).
  const rawSha = input('sha', true).toLowerCase().replace(/^commit\./, '')
  const [parsed] = parseConfiguredPreviewRefs(`commit.${rawSha}`)
  const ref = `commit.${parsed.ref}`
  const version = parsed.version
  const bridge = (input('bridge-url') || 'https://registry-bridge.viteplus.dev').replace(/\/+$/, '')
  const token = input('admin-token', true)
  // Optional: present on pull_request runs, empty on push/commit runs.
  const prUrl = input('pr-url') || undefined

  const cwd = process.cwd()
  const dirs = expandPackageDirs(
    parsePackagesInput(input('packages') || DEFAULT_PACKAGES),
    cwd,
  )
  const packages = dirs.map((dir) => ({ dir, manifest: readManifest(dir) }))

  // Locally packed manifests never carry pkg.pr.new URL deps, so the
  // pkg.pr.new fields of the shared config stay unset here.
  const env: RewriteEnv = {
    PUBLIC_BASE_URL: bridge,
    WORKSPACE_PACKAGES: input('workspace-packages') || 'vite-plus,@voidzero-dev/vite-plus-*',
  }

  // The batch (every name publishing together) drives dependency rewriting;
  // validation fails up front, before anything is packed or uploaded.
  const batch = assertValidBatch(packages, env)

  console.log(`publishing ${version} (${packages.length} packages) to ${bridge}`)

  const post = (path: string, body: Record<string, unknown>, label: string) =>
    withRetry(label, async () => {
      const res = await fetch(`${bridge}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
    })

  // Pack, rewrite + re-pack + hash, upload the bytes, and immediately publish
  // this package's meta, so the stored tarball and the meta the packument
  // serves can never diverge for longer than this one package's upload. A run
  // cancelled part-way leaves later packages untouched instead of stranding
  // bytes without metas. Reuses the Worker's own build so CI's artifact is
  // exactly what the Worker would describe.
  //
  // The next `pnpm pack` runs while the current package uploads (one ahead,
  // bounding memory to two tarballs); the bridge-visible order, upload then
  // publish per package with register last, is unchanged. The swallowed
  // rejection resurfaces at the `await`; it only avoids an unhandled-rejection
  // crash when an upload fails first.
  const startPack = (i: number) => {
    const packed = packDirectory(packages[i].dir)
    packed.catch(() => {})
    return packed
  }
  let nextPack = startPack(0)
  for (let i = 0; i < packages.length; i++) {
    const { dir, manifest } = packages[i]
    const packed = await nextPack
    if (i + 1 < packages.length) nextPack = startPack(i + 1)
    const build = await buildPreviewTarball(packed, manifest.name, version, env, batch)
    await uploadTarball(bridge, token, manifest.name, version, build.tarball, build.shasum)
    const pkg = {
      name: manifest.name,
      version,
      packageJson: build.packageJson,
      integrity: build.integrity,
      shasum: build.shasum,
    }
    await post('/-/publish', { ref, packages: [pkg] }, `publish ${manifest.name}`)
    console.log(
      `  ✓ ${manifest.name}@${version} (${build.tarball.byteLength} bytes, from ${relative(cwd, dir)})`,
    )
  }

  // Every package's bytes + meta are stored; registering the ref last flips
  // the whole version visible atomically (a brand-new ref is not served at
  // all until this succeeds).
  await post('/-/register', { ref, prUrl }, 'register ref')
  console.log(`published ${packages.length} packages, registered ${ref}`)

  const out = process.env.GITHUB_OUTPUT
  if (out) {
    const { appendFileSync } = await import('node:fs')
    appendFileSync(out, `version=${version}\n`)
  }
}

main().catch((err) => {
  console.error(`::error::publish-preview: ${err.message ?? err}`)
  process.exitCode = 1
})
