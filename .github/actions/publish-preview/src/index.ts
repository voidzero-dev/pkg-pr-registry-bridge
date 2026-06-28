/**
 * GitHub Action: build + hash a commit's pkg.pr.new preview artifacts and
 * upload them to the registry bridge.
 *
 * This runs the CPU/memory-heavy work (decompress, rewrite, re-pack, hash) in
 * CI, where there is no per-invocation limit, so the Cloudflare Worker only ever
 * streams bytes. It reuses the Worker's own rewrite/digest modules, so the
 * artifacts CI produces are exactly what the Worker would describe.
 *
 * Every package, the small preview packages (vite-plus, core) AND the platform
 * binaries, is rewritten (name/version, plus deps for the preview packages) and
 * re-packed, with integrity over the re-packed bytes. The binary's version is
 * rewritten too so the tarball's internal version matches the resolved version:
 * pnpm's `strict-store-pkg-content-check` rejects a tarball whose package.json
 * version differs from what it resolved, so an as-is upload (version 0.2.1) would
 * fail there even though npm/yarn/bun tolerate it.
 */
import { buildPreviewTarball } from '../../../../src/tarball/buildPreviewTarball'
import { toPkgPrNewUrl } from '../../../../src/preview/toPkgPrNewUrl'
import {
  isPreviewPackage,
  isWorkspacePackage,
  PREVIEW_PACKAGES,
} from '../../../../src/preview/packages'
import { parseConfiguredPreviewRefs } from '../../../../src/preview/parseConfiguredPreviewRefs'
import type { RewriteEnv } from '../../../../src/tarball/rewritePackageJson'

interface PublishPackage {
  name: string
  version: string
  packageJson: Record<string, any>
  integrity: string
  shasum: string
}

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

async function fetchUpstream(
  env: RewriteEnv,
  name: string,
  version: string,
): Promise<Uint8Array> {
  const url = toPkgPrNewUrl(env, name, version)
  if (!url) throw new Error(`cannot build pkg.pr.new url for ${name}@${version}`)
  return withRetry(`download ${name}`, async () => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    return new Uint8Array(await res.arrayBuffer())
  })
}

async function uploadTarball(
  bridge: string,
  token: string,
  name: string,
  version: string,
  bytes: Uint8Array,
): Promise<void> {
  await withRetry(`upload ${name}`, async () => {
    const res = await fetch(`${bridge}/-/tarball/${name}/${version}.tgz`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/gzip' },
      body: bytes,
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
  const bridge = (input('bridge-url') || 'https://pkg-pr-registry-bridge.render.vip').replace(/\/+$/, '')
  const token = input('admin-token', true)
  const env: RewriteEnv = {
    PUBLIC_BASE_URL: bridge,
    PKG_PR_NEW_BASE: (input('pkg-pr-new-base') || 'https://pkg.pr.new').replace(/\/+$/, ''),
    PREVIEW_OWNER: input('owner') || 'voidzero-dev',
    PREVIEW_REPO: input('repo') || 'vite-plus',
    WORKSPACE_PACKAGES: input('workspace-packages') || 'vite-plus,@voidzero-dev/vite-plus-*',
  }

  console.log(`publishing ${version} to ${bridge}`)
  const packages: PublishPackage[] = []

  // Download from pkg.pr.new, rewrite + re-pack + hash, upload the bytes, and
  // return the meta to publish. Reuses the Worker's own build so CI's artifact
  // is exactly what the Worker would describe.
  const buildAndUpload = async (name: string, ver: string): Promise<PublishPackage> => {
    const upstream = await fetchUpstream(env, name, ver)
    const build = await buildPreviewTarball(upstream, name, ver, env)
    await uploadTarball(bridge, token, name, ver, build.tarball)
    console.log(`  ✓ ${name}@${ver} (${build.tarball.byteLength} bytes)`)
    return {
      name,
      version: ver,
      packageJson: build.packageJson,
      integrity: build.integrity,
      shasum: build.shasum,
    }
  }

  // Preview packages first; vite-plus's rewritten optionalDependencies name the
  // platform binaries (each at the version vite-plus declares for it).
  let vitePlusPackageJson: Record<string, any> | undefined
  for (const name of PREVIEW_PACKAGES) {
    const pkg = await buildAndUpload(name, version)
    packages.push(pkg)
    if (name === 'vite-plus') vitePlusPackageJson = pkg.packageJson
  }

  const optionalDeps = (vitePlusPackageJson?.optionalDependencies ?? {}) as Record<string, string>
  const binaries = Object.entries(optionalDeps).filter(
    ([name]) => isWorkspacePackage(name, env) && !isPreviewPackage(name),
  )
  for (const [name, depVersion] of binaries) {
    packages.push(await buildAndUpload(name, depVersion))
  }

  // Publish the metas + register the ref in one call (after every upload, so a
  // stored meta-with-integrity always has its bytes in R2).
  await withRetry('publish', async () => {
    const res = await fetch(`${bridge}/-/publish`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ref, packages }),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  })
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
