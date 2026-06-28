# pkg-pr-registry-bridge

A version-gated npm registry bridge that lets package managers install
[pkg.pr.new](https://pkg.pr.new) Vite+ preview builds using normal npm registry
semantics. Runs as a single Cloudflare Worker.

Live: `https://pkg-pr-registry-bridge.render.vip`

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
- **Tarball** (`GET /tarballs/<pkg>/<version>.tgz`): downloads the upstream
  pkg.pr.new tarball, rewrites `package/package.json` (name, version,
  dependencies), repacks, and serves it. Tarballs are cached in R2; the first
  request per `(name, version)` builds/stores, and the deploy-time warm step
  pre-populates the preview packages. The same build is also served at the
  npm-convention path (`GET /<pkg>/-/<name>-<version>.tgz`) for clients and
  lockfiles that synthesize that URL instead of reading `dist.tarball`;
  non-preview packages/versions on that path are redirected to npm.
- **Transitive deps**: a preview build's `optionalDependencies` point at
  pkg.pr.new (the platform binaries). The bridge rewrites those URLs to
  synthetic **version strings** (`0.0.0-commit.<sha>`) and serves packuments for
  those packages too, so they resolve through the bridge like the other preview
  packages, and the package manager downloads only the binary for the current
  platform (reading os/cpu from the packument) instead of all of them. These
  native binaries are large (tens of MB decompressed), too large to buffer
  within the Worker's 128MB limit, and streaming a generated response truncates.
  So the build **streams** (decompress, swap only `package.json`, re-emit as
  gzip "stored"/uncompressed blocks) into R2 as bounded multipart parts, and the
  cold request returns a 302 to itself so the retry serves the finished object
  straight from R2 with a Content-Length (a plain passthrough that cannot be
  truncated). The deploy-time warm step pre-builds them so installs hit the
  cache. The preview packages themselves are small and keep the buffered,
  R2-cached, integrity path.
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
registry = "https://pkg-pr-registry-bridge.render.vip/"

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

## Why preview refs are configured (`VITE_PLUS_PREVIEW_REFS`)

A package manager fetches the **packument** (`GET /vite-plus`) to discover which
versions exist *before* it resolves a version, and the request carries no
desired-version hint. So the bridge has to know which synthetic preview versions
to list in that packument. pkg.pr.new has no API to enumerate its builds as
semver versions, so the set is configured explicitly.

The tarball endpoint, by contrast, accepts any valid preview version without
configuration; only packument-based discovery needs the list.

The static `VITE_PLUS_PREVIEW_REFS` var is one source; refs can also be added at
runtime via the admin endpoint below (stored in KV), with no redeploy. Both
sources are merged.

## Admin endpoints

Writes are guarded by `Authorization: Bearer <ADMIN_TOKEN>` (set `ADMIN_TOKEN`
with `wrangler secret put`); without it configured the write endpoints return
503. `GET /-/refs` is a public read.

```bash
# List configured refs (static env + runtime KV) - no auth required
curl https://.../-/refs

# Register a ref at runtime (no redeploy). If GITHUB_TOKEN is set, the ref is
# verified to exist in voidzero-dev/vite-plus first.
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"ref":"commit.a832a55"}' https://.../-/refs

# Unregister a ref
curl -X DELETE -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"ref":"commit.a832a55"}' https://.../-/refs

# Purge a generated build from the caches (R2 + edge)
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"package":"vite-plus","version":"0.0.0-commit.a832a55"}' https://.../-/purge
```

A registered ref is reflected immediately and built into the packument on the
next request (and into R2 on first fetch). This is the no-redeploy path for
exposing new pkg.pr.new builds.

### Register and pre-build a commit (`pnpm warm <sha>`)

To make a specific commit install-reliable on the first try, register it **and**
pre-build all its tarballs (including the large platform binaries, whose cold
build is heavy) into R2 in one step:

```bash
PKG_PR_BRIDGE_ADMIN_TOKEN=… pnpm warm <commit-sha>      # or commit.<sha>
```

This registers the ref via `POST /-/refs`, then warms `vite-plus`,
`@voidzero-dev/vite-plus-core`, and every platform binary in vite-plus's
`optionalDependencies` (with retries). After it finishes, installs of that commit
are served entirely from the R2 cache. With no arguments, `pnpm warm` warms the
refs configured in `wrangler.toml` (this also runs as part of `pnpm run deploy`).

### Auto-register via webhook

`POST /-/webhook` is a GitHub webhook receiver (HMAC-verified with
`GITHUB_WEBHOOK_SECRET`). Point a repo `Issue comments` webhook at it: when the
`pkg-pr-new[bot]` comments that a build was published, the bridge auto-registers
the build's commit refs. Setup: [`docs/webhook-setup.md`](./docs/webhook-setup.md).

## Configuration

Set via `wrangler.toml` `[vars]` (tokens via `wrangler secret`):

| Var | Meaning |
| --- | --- |
| `PUBLIC_BASE_URL` | Public origin of the bridge; used in `dist.tarball` URLs. Must match the deployed route. |
| `NPM_REGISTRY` | npm fallback registry (`https://registry.npmjs.org`). |
| `PKG_PR_NEW_BASE` | pkg.pr.new base (`https://pkg.pr.new`). |
| `PREVIEW_OWNER` / `PREVIEW_REPO` | Fixed upstream repo (`voidzero-dev` / `vite-plus`). |
| `VITE_PLUS_PREVIEW_REFS` | Comma-separated commit refs to inject: `commit.<sha>` (PR refs rejected). |
| `WORKSPACE_PACKAGES` | Allowlist for the tarball endpoint and pkg.pr.new-URL dep routing. Exact names or `prefix*`, e.g. `vite-plus,@voidzero-dev/vite-plus-*`. |
| `MAX_TARBALL_BYTES` | Max upstream tarball size (default 64 MiB). |

Bindings/secrets:

- `TARBALL_CACHE` (R2) - generated tarballs + rewritten metadata (incl. integrity). A 90-day expiry lifecycle rule bounds storage (`wrangler r2 bucket lifecycle add ... --expire-days 90`).
- `PREVIEW_REFS` (KV) - runtime-registered refs.
- `ADMIN_TOKEN` (secret) - guards the admin endpoints.
- `GITHUB_TOKEN` (secret, optional) - enables commit existence checks on `/-/refs`.
- `GITHUB_WEBHOOK_SECRET` (secret, optional) - verifies the `/-/webhook` receiver.

## Develop

```bash
pnpm install
pnpm typecheck
pnpm test          # vitest, runs the worker in workerd (Miniflare)
pnpm dev           # local wrangler dev server
```

## Deploy

```bash
# One-time: create the R2 bucket referenced by wrangler.toml
pnpm exec wrangler r2 bucket create pkg-pr-registry-bridge-tarballs

# Deploy, warm the caches, and run the end-to-end bun install check.
# Use `pnpm run deploy` (not `pnpm deploy`, which is pnpm's built-in command).
pnpm run deploy
```

`pnpm run deploy` runs `wrangler deploy`, then `pnpm warm` (pre-builds the
configured preview refs into R2 so installs are served from cache), then
`pnpm test:e2e` (a real `bun install` against the live bridge that asserts the
alias/override resolves to the synthetic version). Use `pnpm run deploy:only` to
deploy without the post-deploy checks.

## Status

MVP1 + MVP2 of the RFC, deployed: default-registry bridge with npm redirect
fallback, `commit.<sha>` preview injection, tarball rewrite, R2 + edge
caching, deploy-time warm, computed SHA-512/SHA-1 integrity, KV-backed dynamic
refs, authenticated admin endpoints (`/-/refs`, `/-/purge`), optional GitHub
existence checks, and the pkg.pr.new auto-register webhook (`/-/webhook`), plus a
bun end-to-end check. Remaining (MVP3): more workspace packages via config and
metrics.
