// Smoke-test a deployed bridge against its REAL runtime. This catches
// platform-only failures the vitest pool-workers runtime cannot emulate, e.g.
// the void platform forbidding `caches.default` (which 500'd every packument
// while all unit tests passed). Run it against staging before promoting to
// production.
//
//   node scripts/smoke-test.mjs <base-url> [--write]
//
// Each check prints the actual response (status + key fields/headers) BEFORE
// asserting, so a failure is debuggable straight from the CI log.
//
// `--write` (staging only, never production) additionally runs the full admin
// write lifecycle end-to-end against the real runtime: upload a tarball,
// publish its meta, assert the version is NOT served until the ref is
// registered, register it, then assert the packument advertises an integrity
// that matches the exact served tarball bytes. This is the publish -> register
// -> serve -> integrity path that two production incidents broke while every
// unit test stayed green; it self-cleans by purging (and unregistering) the
// artifact afterward. The flag is explicit so a missing SMOKE_ADMIN_TOKEN
// fails loudly instead of silently skipping the coverage.

import { createTarGzip } from 'nanotar'
import { createHash } from 'node:crypto'
import { refToVersion } from './lib/config.mjs'

const args = process.argv.slice(2)
const WRITE = args.includes('--write')
const base = (args.find((a) => !a.startsWith('--')) ?? '').replace(/\/+$/, '')
if (!base) {
  console.error('usage: node scripts/smoke-test.mjs <base-url> [--write]')
  process.exit(2)
}

const ADMIN_TOKEN = process.env.SMOKE_ADMIN_TOKEN
if (WRITE && !ADMIN_TOKEN) {
  console.error("--write requires SMOKE_ADMIN_TOKEN (the deployment's ADMIN_TOKEN)")
  process.exit(2)
}

// Any valid commit sha: the download/HEAD checks resolve a sha to its synthetic
// version without a registry lookup, so this need not be a registered ref. The
// packument check relies on npm's stable versions, not a preview ref, so the
// smoke test does not depend on any ref being registered.
const SHA = '6acea1aa818e96365b5811d47360367ba18a3a05'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const truncate = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s)

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

// npm dist.integrity SRI from tarball bytes.
const sri = (buf) => `sha512-${createHash('sha512').update(buf).digest('base64')}`

const postJson = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  })

/**
 * The full admin write lifecycle against the real runtime. Uses a unique,
 * clearly-labelled `e2e` commit sha per run so it never collides with real
 * refs, and purges + unregisters the artifact at the end.
 */
async function runAdminLifecycle() {
  const name = 'vite-plus'
  // Unique per run, valid [0-9a-f]{7,40}, recognizable as a smoke artifact.
  const ref = `commit.e2e${Date.now().toString(16)}`
  const version = refToVersion(ref)

  // Build a real, valid preview tarball and derive its integrity from the exact
  // bytes we upload, the same way CI's publish action does.
  const tarball = await createTarGzip([
    { name: 'package/package.json', data: JSON.stringify({ name, version }) },
    { name: 'package/index.js', data: 'export const smoke = true\n' },
  ])
  const integrity = sri(tarball)
  // sha1 hex, the content id in the content-addressed tarball URL/key.
  const shasum = createHash('sha1').update(tarball).digest('hex')

  const fetchDist = async () => {
    const res = await fetch(`${base}/${name}`, {
      headers: { accept: 'application/vnd.npm.install-v1+json' },
    })
    const body = await res.json()
    return body?.versions?.[version]?.dist ?? null
  }

  try {
    // 1. Upload the tarball bytes to the content-addressed path (shasum in the
    // key); the worker streams them straight into R2.
    const up = await fetch(`${base}/-/tarball/${name}/${version}/${shasum}.tgz`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/gzip' },
      body: tarball,
    })
    console.log(`    PUT tarball -> ${up.status}`)
    assert(up.status === 201, `upload status ${up.status}`)

    // 2. Publish the meta. This must NOT make the version visible on its own.
    const pub = await postJson('/-/publish', {
      ref,
      packages: [{ name, version, packageJson: { name, version }, integrity, shasum }],
    })
    console.log(`    POST /-/publish -> ${pub.status}`)
    assert(pub.status === 201, `publish status ${pub.status}`)

    // 3. The atomic gate: an unregistered version is invisible in the packument.
    const beforeRegister = await fetchDist()
    console.log(`    packument before register: ${beforeRegister ? 'PRESENT (bug)' : 'absent'}`)
    assert(!beforeRegister, 'version visible before /-/register (atomic gate broken)')

    // 4. Register the ref: flips the version visible.
    const reg = await postJson('/-/register', { ref })
    console.log(`    POST /-/register -> ${reg.status}`)
    assert(reg.status === 201, `register status ${reg.status}`)

    // 5. Now it is served, and its advertised integrity must match the bytes
    // (the invariant both production incidents violated).
    const dist = await fetchDist()
    console.log(
      `    packument after register: integrity=${dist?.integrity?.slice(0, 20)}… tarball=${dist?.tarball}`,
    )
    assert(dist, 'version absent from packument after register')
    assert(dist.integrity === integrity, 'packument integrity != uploaded integrity')
    // dist.tarball is the content-addressed URL: the shasum lives in the path,
    // so the URL pins the exact build the integrity was computed from.
    assert(
      dist.tarball && dist.tarball.endsWith(`/tarballs/${name}/${version}/${shasum}.tgz`),
      `dist.tarball is not the content URL: ${dist.tarball}`,
    )

    // 6. Fetch the actually-served tarball from the runtime under test and
    // confirm its bytes hash to the advertised integrity (catches a stale or
    // mismatched served body directly). Use dist.tarball's PATH against `base`
    // rather than its absolute URL: a staging deploy sets PUBLIC_BASE_URL to
    // the production host, so dist.tarball points at prod, where this staging
    // artifact does not exist. We want to verify the bytes THIS runtime serves.
    assert(dist.tarball, 'no dist.tarball in packument')
    const tarUrl = `${base}${new URL(dist.tarball).pathname}`
    const tres = await fetch(tarUrl)
    const served = new Uint8Array(await tres.arrayBuffer())
    const servedIntegrity = sri(served)
    console.log(
      `    GET ${tarUrl} -> ${tres.status}, served integrity=${servedIntegrity.slice(0, 20)}…`,
    )
    assert(tres.status === 200, `served tarball status ${tres.status}`)
    assert(servedIntegrity === integrity, 'served tarball bytes != advertised integrity')
  } finally {
    // Fully clean up: unregister too, or every run leaks a registered e2e ref
    // into /-/refs (and packument rebuilds) until the 90-day TTL.
    const p = await postJson('/-/purge', { package: name, version, unregister: true }).catch(
      () => null,
    )
    console.log(`    cleanup: purge+unregister -> ${p ? p.status : 'error (ignored)'}`)
  }
}

const checks = [
  {
    name: 'GET /_health',
    async run() {
      const res = await fetch(`${base}/_health`)
      const body = await res.text()
      console.log(`    ${res.status} ${truncate(body)}`)
      assert(res.status === 200, `status ${res.status}`)
      assert(JSON.parse(body)?.status === 'ok', 'status != "ok"')
    },
  },
  {
    name: 'GET /vite-plus',
    async run() {
      const res = await fetch(`${base}/vite-plus`, {
        headers: { accept: 'application/json' },
      })
      const body = await res.text()
      const parsed = JSON.parse(body || 'null')
      const nv = parsed?.versions ? Object.keys(parsed.versions).length : 0
      const nt = parsed?.time ? Object.keys(parsed.time).length : 0
      // The body is large on success, so summarize; print it on failure.
      console.log(
        `    ${res.status} versions=${nv} time=${nt}` +
          (res.status === 200 ? '' : ` ${truncate(body)}`),
      )
      assert(res.status === 200, `status ${res.status}`)
      assert(nv > 0, 'no versions')
      // The `time` map is what 500'd under the void Cache API ban, so it is the
      // load-bearing assertion: the packument handler must complete and emit it.
      assert(nt > 0, 'no time map')
    },
  },
  {
    name: 'GET /-/refs',
    async run() {
      const res = await fetch(`${base}/-/refs`)
      const body = await res.text()
      const parsed = JSON.parse(body || 'null')
      const nr = Array.isArray(parsed?.refs) ? parsed.refs.length : 'n/a'
      console.log(`    ${res.status} refs=${nr}` + (res.status === 200 ? '' : ` ${truncate(body)}`))
      assert(res.status === 200, `status ${res.status}`)
      assert(Array.isArray(parsed?.refs), 'refs is not an array')
    },
  },
  {
    name: 'GET /<owner>/<repo>@<sha> (302 to tarball)',
    async run() {
      const res = await fetch(`${base}/voidzero-dev/vite-plus@${SHA}`, {
        redirect: 'manual',
      })
      console.log(`    ${res.status} location=${res.headers.get('location')}`)
      assert(res.status === 302, `status ${res.status}`)
      assert(res.headers.get('location'), 'no location header')
    },
  },
  {
    name: 'HEAD /<owner>/<repo>@<sha> (commit key)',
    async run() {
      const res = await fetch(`${base}/voidzero-dev/vite-plus@${SHA}`, {
        method: 'HEAD',
      })
      const key = res.headers.get('x-commit-key')
      console.log(
        `    ${res.status} x-commit-key=${key} x-pkg-name-key=${res.headers.get('x-pkg-name-key')}`,
      )
      assert(res.status === 200, `status ${res.status}`)
      assert(key === `voidzero-dev:vite-plus:${SHA}`, `x-commit-key=${key}`)
    },
  },
]

if (WRITE) {
  // Not retried (`retry: false`): a retry after a partial run would false-fail
  // the "invisible before register" gate, and the sha is unique per run anyway.
  checks.push({
    name: 'admin publish -> register -> serve -> integrity (lifecycle)',
    retry: false,
    run: runAdminLifecycle,
  })
} else {
  console.log('read-only mode (pass --write to include the admin lifecycle)')
}

console.log(`smoke-testing ${base}`)

// Retry each check until it passes or a shared deadline, to ride out edge
// propagation right after a deploy: a fresh `void deploy` returns before the new
// worker is live on every edge node, and `/_health` is 200 on both old and new
// code, so it alone can't tell them apart (this caused a false prod-smoke
// failure where HEAD briefly hit an old node, x-commit-key=null). A genuinely
// failing check exhausts the deadline; later checks then fail fast.
const deadline = Date.now() + 60_000

// Run a check (it logs its response each attempt); throw the last error once the
// deadline passes.
async function runWithRetry(check) {
  for (;;) {
    try {
      return await check.run()
    } catch (err) {
      if (Date.now() >= deadline) throw err
      await sleep(4000)
    }
  }
}

let failed = 0
for (const check of checks) {
  try {
    await (check.retry === false ? check.run() : runWithRetry(check))
    console.log(`  ✓ ${check.name}`)
  } catch (err) {
    console.error(`  ✗ ${check.name}: ${err.message}`)
    failed++
  }
}

if (failed > 0) {
  console.error(`\n${failed} smoke check(s) failed against ${base}`)
  process.exit(1)
}
console.log(`\nall ${checks.length} smoke checks passed against ${base}`)
