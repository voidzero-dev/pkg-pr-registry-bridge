# pkg-pr-registry-bridge

A version-gated npm registry bridge that lets package managers install
[pkg.pr.new](https://pkg.pr.new) Vite+ preview builds using normal npm registry
semantics. Runs as a single Cloudflare Worker.

Live: `https://registry-bridge.viteplus.dev`

The package name selects the upstream package; the version pattern selects the
source:

```
@voidzero-dev/vite-plus-core@0.0.0-commit.a832a55  -> pkg.pr.new commit build
vite-plus@0.0.0-commit.a832a55                     -> pkg.pr.new commit build
vite-plus@0.2.1, react@latest                      -> npm registry
```

Only **immutable commit builds** (`0.0.0-commit.<sha>`) are supported. PR-number
versions (`0.0.0-pr.<n>`) are intentionally rejected: a PR ref is mutable (it
advances to newer commits), so its generated metadata/tarball would be
overwritten and could mismatch what a consumer already pinned in a lockfile.
Pinning a commit sha keeps the content immutable.

This makes a Bun alias override work through the bridge:

```json
{
  "overrides": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-commit.a832a55"
  }
}
```

See [`rfcs/0001-pkg-pr-new-registry-bridge-cloudflare-workers.md`](./rfcs/0001-pkg-pr-new-registry-bridge-cloudflare-workers.md)
for the full design, and [`examples/bun-validation`](./examples/bun-validation)
for a runnable example.

## How it works

- **Packument** (`GET /vite-plus`, `GET /@voidzero-dev/vite-plus-core`): fetches
  the npm packument (or synthesizes an empty one if the package is not on npm),
  injects the configured preview versions, and leaves existing versions and
  `latest` untouched.
- **Tarball** (`GET /tarballs/<pkg>/<version>.tgz`): served straight from R2,
  the single source of truth. Artifacts are built and hashed **in CI** (the
  publish action below) and uploaded, so the Worker only streams bytes, it never
  decompresses or hashes a payload, so it cannot hit the Worker CPU/memory limits
  regardless of size. The same object is served at the npm-convention path
  (`GET /<pkg>/-/<name>-<version>.tgz`) for clients and lockfiles that synthesize
  that URL instead of reading `dist.tarball`; non-preview packages/versions there
  are redirected to npm.
- **Transitive deps**: a preview build's `optionalDependencies` (the platform
  binaries) are pinned to the same synthetic **version string**
  (`0.0.0-commit.<sha>`), and the bridge serves packuments for those packages
  too, so they resolve through the bridge like the other preview packages, and
  the package manager downloads only the binary for the current platform
  (reading os/cpu from the packument) instead of all of them. The publish
  action pins any dep on a package of the same publish batch; the Worker's
  on-demand fallback equivalently rewrites the pkg.pr.new dependency URLs
  found in upstream tarballs. The binaries are large (tens of MB), so they are
  packed + hashed in CI (where there is no per-request limit) and uploaded;
  the binary's `package.json` version is rewritten to the synthetic version so
  it matches what the resolver expects (pnpm's strict store check rejects a
  mismatch). A platform binary not yet uploaded for a registered ref redirects
  to pkg.pr.new as a best-effort fallback. The small preview packages can also
  be built in-Worker on demand as a fallback (they are small enough to stay
  within the limits).
- **Publishing** (`POST /-/publish`, `PUT /-/tarball/...`): the
  [publish action](#publishing-from-ci) packs each locally built package
  directory (in the same CI job that produced the artifacts, no pkg.pr.new
  round-trip), rewrites + re-packs + hashes it, `PUT`s the bytes, and `POST`s
  the metadata (rewritten package.json + integrity) and registers the ref, all
  in one CI run.
  Because integrity is computed over the exact bytes served, every package
  manager that verifies it (npm, pnpm, yarn) gets a match, and bun/yarn-berry pin
  it on first install.
- **Everything else**: 302-redirected to `registry.npmjs.org`, so the client
  fetches the hundreds of normal packages in a typical install directly from
  npm's CDN. The Worker stays out of the data path for everything it doesn't
  synthesize.

Only `@voidzero-dev/vite-plus-core` and `vite-plus` receive synthetic preview
versions (strict allowlist). Owner/repo are fixed to `voidzero-dev/vite-plus`.

## Consumer configuration (important)

`bunfig.toml`:

```toml
[install]
registry = "https://registry-bridge.viteplus.dev/"

# REQUIRED for large installs. Bun's default network concurrency (48) triggers
# an HTTP/2 client bug against Cloudflare on big dependency graphs (vite-plus
# pulls 400+ packages): streams get dropped and resolution fails with "no
# version matching". Capping concurrency avoids it. The bridge serves correct
# responses; this is a bun-side workaround.
networkConcurrency = 8
```

`package.json` (prefer an immutable commit build for reproducibility):

```json
{
  "devDependencies": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-commit.<sha>",
    "@voidzero-dev/vite-plus-core": "0.0.0-commit.<sha>",
    "vite-plus": "0.0.0-commit.<sha>"
  },
  "overrides": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-commit.<sha>"
  }
}
```

> Note on registry env overrides: bun honours `npm_config_registry` (which
> pnpm/npm derive from e.g. `PNPM_CONFIG_REGISTRY`) over `bunfig.toml`. If you
> run `bun install` through another package manager's script and have a registry
> mirror configured, unset that override or run bun directly so the bridge
> registry is used.

## Why the bridge needs a list of preview refs

A package manager fetches the **packument** (`GET /vite-plus`) to discover which
versions exist *before* it resolves a version, and the request carries no
desired-version hint. So the bridge has to know which synthetic preview versions
to list in that packument. pkg.pr.new has no API to enumerate its builds as
semver versions, so the set is maintained explicitly.

The tarball endpoint, by contrast, accepts any valid preview version without
configuration; only packument-based discovery needs the list.

Refs are registered at runtime via the admin endpoints below (the publish action
calls them from CI), stored in a single R2 index object read with a cheap `get`
(not a rate-limited KV `list`) and pruned by a TTL. No redeploy and no static
configuration: a published preview appears as soon as the action registers it.

For refs published from a PR (the action forwards the PR url), the served
packument also exposes a `pr-<n>` dist-tag pointing at that PR's
latest-published commit version. The per-commit versions stay immutable; the tag
moves as the PR advances, so `npm/pnpm install <pkg>@pr-<n>` against this
registry installs the PR's head build.

## Direct tarball download (pkg.pr.new-style)

A pkg.pr.new-style URL resolves a ref to a tarball, handy for a `curl` download
or a single self-contained package. Swap the hostname on any pkg.pr.new URL:

```bash
# The repo's main package (vite-plus) at a PR's latest commit, or a commit sha:
curl -L https://registry-bridge.viteplus.dev/voidzero-dev/vite-plus@1891
curl -L https://registry-bridge.viteplus.dev/voidzero-dev/vite-plus@<sha>
# A specific (here scoped) package:
curl -L https://registry-bridge.viteplus.dev/voidzero-dev/vite-plus/@voidzero-dev/vite-plus-core@1891
```

A `GET` 302-redirects to the canonical `/tarballs/<pkg>/<version>.tgz`. A `HEAD`
answers `200` (no body) and resolves the ref to its exact commit via
pkg.pr.new-style headers, so a tool can pin a (mutable) PR number to a commit
without downloading:

```bash
curl -I https://registry-bridge.viteplus.dev/voidzero-dev/vite-plus@1891
# HTTP/2 200
# x-commit-key: voidzero-dev:vite-plus:<sha>
# x-pkg-name-key: vite-plus
```

Both `GET` and `HEAD` carry `x-commit-key`/`x-pkg-name-key`. Note the bridge
rewrites a preview tarball's transitive deps to versions (not pkg.pr.new URLs),
so for a full install of the meta-package with its platform binaries, use the
registry + `pr-<n>` tag above rather than this URL as a bare dependency.

## Admin endpoints

Writes are guarded by `Authorization: Bearer <ADMIN_TOKEN>` (set `ADMIN_TOKEN`
with `void secret put ADMIN_TOKEN`); without it configured the write endpoints
return 503. `GET /-/refs` is a public read.

```bash
# List registered refs - no auth required.
# Each entry: { ref, version, publishedAt, prUrl, expiresAt }. publishedAt is the
# server-stamped release date; prUrl is null unless published from a PR; expiresAt
# is the index TTL (90 days out).
curl https://.../-/refs

# Purge a generated build (its tarball + meta) from R2
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"package":"vite-plus","version":"0.0.0-commit.a832a55"}' https://.../-/purge
```

Refs are created by publishing: tarball upload (`PUT /-/tarball/<pkg>/<version>.tgz`)
then `POST /-/publish` (stores metadata + registers the ref), both admin-guarded
and driven by the [publish action](#publishing-from-ci), not by hand.

A published ref is reflected immediately and built into the packument on the next
request. This is the no-redeploy path for exposing new preview builds.

### Publishing from CI

The heavy work (pack, rewrite, re-pack, hash) runs in CI via a reusable
action, in the same job that built the artifacts, so the Worker only serves
and pkg.pr.new is not involved. Wire it into vite-plus's publish workflow: see
[`docs/ci-setup.md`](./docs/ci-setup.md). To publish by hand (same code path),
run `PKG_PR_BRIDGE_ADMIN_TOKEN=… pnpm warm --repo <built-vite-plus-checkout> <sha>`.

The action's bundle is committed
(`.github/actions/publish-preview/dist/index.mjs`); rebuild it with
`pnpm build:action` after changing the action or any module it imports.

## Configuration

Non-secret values are declared in `env.ts` (typed and validated) and set in
`.env` (committed), with per-environment overrides in `.env.production`. Secrets
are uploaded with `void secret put`:

| Var | Meaning |
| --- | --- |
| `PUBLIC_BASE_URL` | Public origin of the bridge; used in `dist.tarball` URLs. Must match the deployed route. |
| `NPM_REGISTRY` | npm fallback registry (`https://registry.npmjs.org`). |
| `PKG_PR_NEW_BASE` | pkg.pr.new base (`https://pkg.pr.new`). |
| `PREVIEW_OWNER` / `PREVIEW_REPO` | Fixed upstream repo (`voidzero-dev` / `vite-plus`). |
| `WORKSPACE_PACKAGES` | Allowlist for the tarball endpoint and pkg.pr.new-URL dep routing. Exact names or `prefix*`, e.g. `vite-plus,@voidzero-dev/vite-plus-*`. |
| `MAX_TARBALL_BYTES` | Max upstream tarball size (default 64 MiB). |

Bindings/secrets:

- `STORAGE` (R2) - generated tarballs, rewritten metadata (incl. integrity), and the runtime-registered refs index. Auto-provisioned by Void on deploy (no manual bucket creation); the binding is declared in `void.json` (`inference.bindings.storage`). The runtime refs index self-expires after 90 days (in-code TTL), and a daily Void cron (`crons/cleanup-expired.ts`) sweeps the per-version meta/tarball objects once their ref TTL lapses, so R2 storage stays bounded to the active-ref window.
- `ADMIN_TOKEN` (secret) - guards the admin endpoints. Set with `void secret put ADMIN_TOKEN`.

## Develop

This is a [Void](https://void.cloud) app: `voidPlugin()` in `vite.config.ts`
builds the Worker from the `routes/` layer, which forwards every request to the
Hono registry app in `src/app.ts`. Void infers the `STORAGE` R2 binding and
loads `.env*` into the Worker's vars.

```bash
pnpm install       # also runs `void prepare` (generates .void/ types)
pnpm typecheck
pnpm test          # vitest, runs the worker in workerd (Miniflare)
pnpm dev           # `vite dev` (local worker via Miniflare, http://localhost:5173)
```

For local admin testing, put `ADMIN_TOKEN=…` in `.env.local` (gitignored).

## Deploy

Deploys to the [Void](https://void.cloud) managed platform with `void deploy`;
Void provisions the Worker and the `STORAGE` R2 bucket (no Cloudflare account
needed).

```bash
# One-time: authenticate and set the admin secret on the project.
void auth login
void secret put ADMIN_TOKEN              # guards the admin write endpoints

# Deploy and run the end-to-end bun install check.
# Use `pnpm run deploy` (not `pnpm deploy`, which is pnpm's built-in command).
pnpm run deploy                          # void deploy + e2e
```

`pnpm run deploy` runs `void deploy`, then `pnpm test:e2e` (a real
`bun install` against the live bridge that asserts the alias/override resolves
to the synthetic version, using a ref the bridge already serves). Use
`pnpm run deploy:only` for `void deploy` alone.

The public origin (`PUBLIC_BASE_URL` in `.env.production`) is the custom domain
`https://registry-bridge.viteplus.dev`, attached with `void domain add` (the
underlying Void platform URL `pkg-pr-registry-bridge.void.app` keeps working
too).

CI deploys in two stages, both smoke-testing the REAL Void runtime, which the
`pool-workers` unit tests can't emulate (e.g. the platform forbidding
`caches.default`, which 500'd every packument while all unit tests passed):

- **Every PR** (`.github/workflows/staging.yml`) deploys the change to the
  shared **staging** project (`pkg-pr-registry-bridge-staging.void.app`) and
  runs `scripts/smoke-test.mjs` against it. Make `Staging` a required status
  check (branch protection) so a failing smoke test blocks the merge. (Skipped
  for fork PRs, which can't read `VOID_TOKEN`.)
- **Push to `main`** (`.github/workflows/deploy.yml`) re-runs the staging deploy
  + smoke as a gate, then deploys to production and smoke-tests it. The gate is
  necessary because a change can reach `main` without the PR check, a fork PR or
  a direct push, so production never ships unless staging passes first.

The smoke test hits `/_health`, the `/vite-plus` packument (200 with `time`),
`/-/refs`, and a download redirect.

Add a `VOID_TOKEN` repository secret (`void auth token` copies one to your
clipboard); the same token deploys both projects. Run the smoke test locally
with `pnpm smoke <url>`, and deploy staging by hand with `pnpm deploy:staging`.
