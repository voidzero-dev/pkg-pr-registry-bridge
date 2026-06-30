// Smoke-test a deployed bridge against its REAL runtime. This catches
// platform-only failures that the vitest pool-workers runtime cannot emulate,
// e.g. the void platform forbidding `caches.default` (which 500'd every
// packument in production while all unit tests passed). Run it against staging
// before promoting to production.
//
//   node scripts/smoke-test.mjs https://pkg-pr-registry-bridge-staging.void.app

const base = (process.argv[2] || '').replace(/\/+$/, '')
if (!base) {
  console.error('usage: node scripts/smoke-test.mjs <base-url>')
  process.exit(2)
}

// A configured commit ref (also a valid sha for the download endpoint).
const SHA = '6acea1aa818e96365b5811d47360367ba18a3a05'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const checks = [
  {
    name: 'GET /_health -> 200 {status:"ok"}',
    async run() {
      const res = await fetch(`${base}/_health`)
      assert(res.status === 200, `status ${res.status}`)
      const body = await res.json()
      assert(body?.status === 'ok', `body ${JSON.stringify(body)}`)
    },
  },
  {
    name: 'GET /vite-plus -> 200 with versions + time',
    async run() {
      const res = await fetch(`${base}/vite-plus`, {
        headers: { accept: 'application/json' },
      })
      assert(res.status === 200, `status ${res.status}`)
      const body = await res.json()
      assert(
        body?.versions && Object.keys(body.versions).length > 0,
        'no versions',
      )
      // The `time` map is what 500'd under the void Cache API ban, so it is the
      // load-bearing assertion: the packument handler must complete and emit it.
      assert(body?.time && Object.keys(body.time).length > 0, 'no time map')
    },
  },
  {
    name: 'GET /-/refs -> 200 with refs[]',
    async run() {
      const res = await fetch(`${base}/-/refs`)
      assert(res.status === 200, `status ${res.status}`)
      const body = await res.json()
      assert(Array.isArray(body?.refs), 'refs is not an array')
    },
  },
  {
    name: 'GET /<owner>/<repo>@<sha> -> 302 to a tarball',
    async run() {
      const res = await fetch(`${base}/voidzero-dev/vite-plus@${SHA}`, {
        redirect: 'manual',
      })
      assert(res.status === 302, `status ${res.status}`)
      assert(res.headers.get('location'), 'no location header')
    },
  },
]

console.log(`smoke-testing ${base}`)

// Wait for the new deployment to go live (edge propagation) before asserting.
async function waitForLive() {
  for (let i = 0; i < 10; i++) {
    try {
      await checks[0].run()
      return
    } catch {
      await sleep(3000)
    }
  }
  // One more, surfacing the real error.
  await checks[0].run()
}
await waitForLive()

let failed = 0
for (const check of checks) {
  try {
    await check.run()
    console.log(`  ✓ ${check.name}`)
  } catch (err) {
    failed++
    console.error(`  ✗ ${check.name}: ${err.message}`)
  }
}

if (failed > 0) {
  console.error(`\n${failed} smoke check(s) failed against ${base}`)
  process.exit(1)
}
console.log(`\nall ${checks.length} smoke checks passed against ${base}`)
