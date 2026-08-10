/**
 * GitHub Action: pack a commit's locally built packages and publish them to
 * the registry bridge.
 *
 * Runs the CPU/memory-heavy work (rewrite, re-pack, hash) in CI, where there
 * is no per-invocation limit, so the Cloudflare Worker only ever streams
 * bytes. Each directory is packed with `pnpm pack` (resolving
 * workspace:/catalog: specs; run `pnpm install` first), then rewritten,
 * re-packed and hashed with the Worker's own modules, so CI's artifacts are
 * exactly what the Worker would describe.
 *
 * Every package is rewritten to the synthetic commit version, and deps between
 * packages of the same batch are pinned to it. The version rewrite matters even
 * for the platform binaries: pnpm's `strict-store-pkg-content-check` rejects a
 * tarball whose package.json version differs from the version it resolved.
 *
 * Three modes (RFC 0002):
 *
 *  - `publish` (default): pack and upload in one job, authenticated by
 *    `admin-token`. The original behaviour, kept for `scripts/warm.mjs` and
 *    manual runs, where the checkout and the credential are both trusted.
 *  - `pack`: the local half only, writing raw `pnpm pack` output to
 *    `output-dir`. No network and no credentials, so it can run in a job that
 *    builds an untrusted fork pull request.
 *  - `upload`: the remote half only, reading `input-dir`. Runs in the trusted
 *    `workflow_run` workflow and treats the artifact as hostile: every archive
 *    validated against the SR-6 canonical policy, the version comes from the
 *    trusted `sha` input, and each package is REBUILT here so the bytes
 *    published are ones this step constructed.
 */
import { join, relative } from 'node:path'
import { appendFileSync, writeFileSync } from 'node:fs'
import { buildPreviewTarball } from '../../../../src/tarball/buildPreviewTarball'
import { validateArchive } from '../../../../src/tarball/validateArchive'
import { isPackageManifest } from '../../../../src/security/validateTarballPath'
import { DEPENDENCY_FIELDS } from '../../../../src/tarball/rewritePackageJson'
import { parseConfiguredPreviewRefs } from '../../../../src/preview/parseConfiguredPreviewRefs'
import {
  assertValidBatch,
  expandPackageDirs,
  packDirectory,
  parsePackagesInput,
  readManifest,
} from './localPack'
import {
  prepareOutputDir,
  readArtifactTarballs,
  readTarball,
  tarballFileName,
  writeManifest,
} from './artifact'
import { oidcMinter, staticToken, type TokenMinter } from './oidcToken'

// The vite-plus layout, overridable via the `packages` input. Lives here (not
// action.yml) so direct invocations of the bundle (scripts/warm.mjs) get the
// same default.
const DEFAULT_PACKAGES =
  'packages/cli,packages/core,packages/prompts,packages/cli/npm/*,packages/cli/cli-npm/*'

const MODES = new Set(['publish', 'pack', 'upload'])

// GitHub exposes inputs as INPUT_<NAME> with the name uppercased and dashes
// PRESERVED (`admin-token` -> `INPUT_ADMIN-TOKEN`), which scripts/warm.mjs also
// relies on. Do not "normalize" dashes to underscores here.
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

/** One package ready to publish: how to get its bytes, and what to call it. */
interface PackageSource {
  /** Package name, resolved before publishing starts. */
  name: string
  /** Human-readable origin, for logs and errors. */
  label: string
  read: () => Promise<Uint8Array>
  /**
   * Whether reading is worth starting one package early. True only when `read`
   * is genuinely expensive and asynchronous (`pnpm pack` spawns a process); a
   * synchronous `readFileSync` returns an already-settled promise, so
   * prefetching it just holds an extra archive resident for no overlap.
   */
  prefetch?: boolean
}

/**
 * One request to the bridge, with the retry, auth and error policy that every
 * call shares. A 401 is worth one fresh mint: an OIDC token can expire mid-run
 * on a slow upload.
 */
function send(
  bridge: string,
  auth: TokenMinter,
  path: string,
  label: string,
  init: {
    method: string
    body: Uint8Array | string
    contentType: string
    timeoutMs: number
  },
): Promise<void> {
  return withRetry(label, async () => {
    const res = await fetch(`${bridge}${path}`, {
      method: init.method,
      headers: {
        authorization: await auth.header(),
        'content-type': init.contentType,
      },
      body: init.body,
      signal: AbortSignal.timeout(init.timeoutMs),
    })
    if (res.status === 401) auth.invalidate()
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => '')}`)
  })
}

function uploadTarball(
  bridge: string,
  auth: TokenMinter,
  name: string,
  version: string,
  bytes: Uint8Array,
  shasum: string,
): Promise<void> {
  // Content-addressed path: the shasum (sha1 of these exact bytes) is in the
  // key, so a republish with different bytes lands at a different URL and the
  // packument's shasum always selects the matching bytes.
  return send(bridge, auth, `/-/tarball/${name}/${version}/${shasum}.tgz`, `upload ${name}`, {
    method: 'PUT',
    body: bytes,
    contentType: 'application/gzip',
    timeoutMs: TRANSFER_TIMEOUT_MS,
  })
}

function post(
  bridge: string,
  auth: TokenMinter,
  path: string,
  body: Record<string, unknown>,
  label: string,
): Promise<void> {
  return send(bridge, auth, path, label, {
    method: 'POST',
    body: JSON.stringify(body),
    contentType: 'application/json',
    timeoutMs: PUBLISH_TIMEOUT_MS,
  })
}

/**
 * Cap on a package.json. The archive policy's per-file limit is sized for
 * binaries, so without a manifest-specific bound a hostile artifact could ship
 * several highly compressible 256MB manifests and have every one parsed and
 * retained across the batch scan.
 */
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024

/**
 * Read `package/package.json` out of an already-validated entry list, keeping
 * only the fields the batch check needs.
 *
 * Projecting rather than retaining the parsed object matters because the scan
 * holds one of these per package until the whole batch is validated, and
 * nothing downstream reads the rest: `buildPreviewTarball` re-reads the
 * manifest from the archive itself.
 */
function manifestFromEntries(
  files: Awaited<ReturnType<typeof validateArchive>>,
  label: string,
): Record<string, any> {
  // validateArchive guarantees exactly one manifest entry, so `find` cannot
  // disagree with what an extractor would pick.
  const entry = files.find((f) => isPackageManifest(f.name) && f.data)
  if (!entry?.data) throw new Error(`${label}: tarball has no package/package.json`)
  if (entry.data.byteLength > MAX_MANIFEST_BYTES) {
    throw new Error(
      `${label}: package.json is ${entry.data.byteLength} bytes, over the ${MAX_MANIFEST_BYTES} byte limit`,
    )
  }
  let parsed: Record<string, any>
  try {
    parsed = JSON.parse(new TextDecoder().decode(entry.data))
  } catch (err) {
    throw new Error(`${label}: invalid package/package.json (${err})`)
  }
  const projected: Record<string, any> = { name: parsed.name }
  for (const field of DEPENDENCY_FIELDS) {
    if (parsed[field]) projected[field] = Object.fromEntries(
      Object.keys(parsed[field]).map((dep) => [dep, true]),
    )
  }
  return projected
}

/**
 * Resolve each untrusted archive to its package name, validating it on the way.
 *
 * The batch invariants (allowed workspace package, no duplicate name, every
 * workspace dep present) are the SAME rules the on-disk path applies, so this
 * collects manifests and hands them to `assertValidBatch` rather than keeping a
 * second copy of them. Bytes are released after each package, so peak memory
 * stays at one archive rather than the whole batch.
 */
async function resolveArchiveBatch(
  sources: PackageSource[],
  env: { WORKSPACE_PACKAGES?: string },
): Promise<Set<string>> {
  const packages = []
  for (const source of sources) {
    const files = await validateArchive(await source.read())
    const manifest = manifestFromEntries(files, source.label)
    // Name each source now, so publishing never has to re-derive it or keep a
    // parallel array in step with `sources`.
    source.name = manifest.name
    packages.push({ label: source.label, manifest })
  }
  return assertValidBatch(packages, env)
}

/**
 * Rebuild, upload and publish each package, then register the ref last so the
 * whole version flips visible atomically. Upload-then-publish per package keeps
 * stored bytes and served metadata from diverging for longer than one upload;
 * a run cancelled part-way leaves later packages untouched.
 */
async function publishAll(opts: {
  sources: PackageSource[]
  batch: Set<string>
  bridge: string
  auth: TokenMinter
  ref: string
  version: string
  prUrl?: string
}): Promise<void> {
  const { sources, batch, bridge, auth, ref, version, prUrl } = opts
  console.log(`publishing ${version} (${sources.length} packages) to ${bridge}`)

  // Read the next package's bytes while the current one uploads, but ONLY where
  // reading is genuinely async: `pnpm pack` spawns a process, so the overlap is
  // real, whereas `readFileSync` returns an already-settled promise and
  // prefetching it just holds a second archive resident through the heaviest
  // allocation phase for no gain. The swallowed rejection resurfaces at the
  // `await`; it only avoids an unhandled-rejection crash when an earlier upload
  // fails first.
  const startRead = (i: number): Promise<Uint8Array> => {
    const pending = sources[i].read()
    pending.catch(() => {})
    return pending
  }
  let nextBytes: Promise<Uint8Array> | null = null

  for (const [i, source] of sources.entries()) {
    const { name } = source
    const bytes = await (nextBytes ?? startRead(i))
    nextBytes =
      source.prefetch && i + 1 < sources.length ? startRead(i + 1) : null
    const build = await buildPreviewTarball(bytes, name, version, batch)
    await uploadTarball(bridge, auth, name, version, build.tarball, build.shasum)
    await post(
      bridge,
      auth,
      '/-/publish',
      {
        ref,
        packages: [
          {
            name,
            version,
            packageJson: build.packageJson,
            integrity: build.integrity,
            shasum: build.shasum,
          },
        ],
      },
      `publish ${name}`,
    )
    // Log the content-addressed tarball URL (the shasum lives in its path) and
    // the integrity, so an install mismatch is debuggable straight from the CI
    // log: fetch the URL, hash it, and compare against the integrity here.
    console.log(
      `  ✓ ${name}@${version} (${build.tarball.byteLength} bytes, from ${source.label})\n` +
        `      ${bridge}/tarballs/${name}/${version}/${build.shasum}.tgz  (${build.integrity})`,
    )
  }

  await post(bridge, auth, '/-/register', { ref, prUrl }, 'register ref')
  console.log(`published ${sources.length} packages, registered ${ref}`)
}

/**
 * Resolve how to authenticate: explicit admin token, else OIDC.
 *
 * OIDC is confined to `upload` mode. `publish` mode packs and uploads in one
 * job, and `pnpm pack` runs the packed package's own `prepack`/`prepare`
 * scripts, so allowing OIDC there would put token minting in a job that
 * executes preview code, which is exactly the separation RFC 0002 SR-5 exists
 * to keep. Requiring an admin token makes that configuration fail loudly
 * instead of silently working.
 */
function resolveAuth(bridge: string, mode: string): TokenMinter {
  const adminToken = input('admin-token')
  if (adminToken) return staticToken(adminToken)
  if (mode !== 'upload') {
    throw new Error(
      `mode: ${mode} requires admin-token. OIDC is only available in mode: upload, ` +
        'which runs in a trusted workflow_run job that never executes packaged ' +
        'code. Split the workflow (see RFC 0002) or pass admin-token.',
    )
  }
  // Audience is the bridge origin, matching OIDC_AUDIENCE on the Worker.
  return oidcMinter(bridge)
}

async function main(): Promise<void> {
  const mode = input('mode') || 'publish'
  if (!MODES.has(mode)) {
    throw new Error(`invalid mode: ${mode} (expected publish, pack or upload)`)
  }

  // Accept a bare sha or `commit.<sha>`; reuse the Worker's parser to validate
  // it and produce the canonical ref + synthetic version (one source of truth).
  // In `upload` mode this is wired to workflow_run.head_sha, a trusted payload
  // field, and is what makes the artifact's own manifest advisory.
  const rawSha = input('sha', true).toLowerCase().replace(/^commit\./, '')
  const [parsed] = parseConfiguredPreviewRefs(`commit.${rawSha}`)
  const ref = `commit.${parsed.ref}`
  const version = parsed.version
  const workspacePackages =
    input('workspace-packages') || 'vite-plus,@voidzero-dev/vite-plus-*'
  const env = { WORKSPACE_PACKAGES: workspacePackages }
  const cwd = process.cwd()

  if (mode === 'pack') {
    const outputDir = input('output-dir') || 'bridge-packages'
    const dirs = expandPackageDirs(parsePackagesInput(input('packages') || DEFAULT_PACKAGES), cwd)
    const packages = dirs.map((dir) => ({ label: dir, manifest: readManifest(dir) }))
    // Fail on the batch before packing anything, so a missing platform dir
    // stops the build workflow rather than producing a partial artifact.
    assertValidBatch(packages, env)

    prepareOutputDir(outputDir)
    const listed: Array<{ file: string; name: string; dir: string }> = []
    for (const [i, { label, manifest }] of packages.entries()) {
      const file = tarballFileName(i)
      writeFileSync(join(outputDir, file), await packDirectory(label))
      listed.push({ file, name: manifest.name, dir: relative(cwd, label) })
      console.log(`  packed ${manifest.name} -> ${file}`)
    }
    writeManifest(outputDir, { ref, version, packages: listed })
    console.log(`packed ${packages.length} packages into ${outputDir}`)
    writeOutput('version', version)
    return
  }

  const bridge = (input('bridge-url') || 'https://registry-bridge.viteplus.dev').replace(/\/+$/, '')
  const auth = resolveAuth(bridge, mode)
  // Optional: the action runs on push commits too, where there is no PR. In
  // `upload` mode the caller derives this from the GitHub API, never from the
  // artifact, so it cannot be used to retarget another PR's dist-tag.
  const prUrl = input('pr-url') || undefined

  if (mode === 'upload') {
    const inputDir = input('input-dir') || 'bridge-packages'
    const paths = readArtifactTarballs(inputDir)
    // `name` is filled in by resolveArchiveBatch, which reads it out of each
    // validated archive. No prefetch: readFileSync is synchronous.
    const sources: PackageSource[] = paths.map((path) => ({
      name: '',
      label: relative(cwd, path),
      read: async () => readTarball(path),
    }))
    // Validate every archive and derive the batch BEFORE uploading anything.
    const batch = await resolveArchiveBatch(sources, env)
    await publishAll({ sources, batch, bridge, auth, ref, version, prUrl })
    writeOutput('version', version)
    return
  }

  // mode === 'publish': the checkout is trusted here, so the batch comes from
  // on-disk manifests as it always has, and packing stays a single pass.
  const dirs = expandPackageDirs(parsePackagesInput(input('packages') || DEFAULT_PACKAGES), cwd)
  const packages = dirs.map((dir) => ({ label: dir, manifest: readManifest(dir) }))
  const batch = assertValidBatch(packages, env)
  // `read` runs exactly once per source here (the batch came from disk), so
  // packing stays a single pass. Prefetch earns its keep: packDirectory spawns
  // `pnpm pack`, so the next pack overlaps the current upload.
  const sources: PackageSource[] = packages.map(({ label, manifest }) => ({
    name: manifest.name,
    label: relative(cwd, label),
    read: () => packDirectory(label),
    prefetch: true,
  }))
  await publishAll({ sources, batch, bridge, auth, ref, version, prUrl })
  writeOutput('version', version)
}

function writeOutput(key: string, value: string): void {
  const out = process.env.GITHUB_OUTPUT
  if (out) appendFileSync(out, `${key}=${value}\n`)
}

main().catch((err) => {
  console.error(`::error::publish-preview: ${err.message ?? err}`)
  process.exitCode = 1
})
