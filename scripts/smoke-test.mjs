// Smoke-test a deployed bridge against its REAL runtime. This catches
// platform-only failures the vitest pool-workers runtime cannot emulate, e.g.
// the void platform forbidding `caches.default` (which 500'd every packument
// while all unit tests passed). Run it against staging before promoting to
// production.
//
//   node scripts/smoke-test.mjs https://pkg-pr-registry-bridge-staging.void.app
//
// Each check prints the actual response (status + key fields/headers) BEFORE
// asserting, so a failure is debuggable straight from the CI log.

const base = (process.argv[2] || '').replace(/\/+$/, '')
if (!base) {
  console.error('usage: node scripts/smoke-test.mjs <base-url>')
  process.exit(2)
}

// A configured commit ref (also a valid sha for the download endpoint).
const SHA = '6acea1aa818e96365b5811d47360367ba18a3a05'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const truncate = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s)

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
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
      console.log(
        `    ${res.status} refs=${nr}` +
          (res.status === 200 ? '' : ` ${truncate(body)}`),
      )
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

console.log(`smoke-testing ${base}`)

// Retry each check until it passes or a shared deadline, to ride out edge
// propagation right after a deploy: a fresh `void deploy` returns before the new
// worker is live on every edge node, and `/_health` is 200 on both old and new
// code, so it alone can't tell them apart (this caused a false prod-smoke
// failure where HEAD briefly hit an old node, x-commit-key=null). A genuinely
// failing check exhausts the deadline; later checks then fail fast.
const deadline = Date.now() + 60_000
let failed = 0
for (const check of checks) {
  let err
  for (;;) {
    err = undefined
    try {
      await check.run() // logs the response on every attempt
      break
    } catch (e) {
      err = e
      if (Date.now() >= deadline) break
      await sleep(4000)
    }
  }
  if (err) {
    console.error(`  ✗ ${check.name}: ${err.message}`)
    failed++
  } else {
    console.log(`  ✓ ${check.name}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} smoke check(s) failed against ${base}`)
  process.exit(1)
}
console.log(`\nall ${checks.length} smoke checks passed against ${base}`)
