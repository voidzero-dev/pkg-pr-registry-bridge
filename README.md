# pkg-pr-registry-bridge

A version-gated npm registry bridge that lets package managers install
[pkg.pr.new](https://pkg.pr.new) Vite+ preview builds using normal npm registry
semantics. Runs as a single Cloudflare Worker.

Live: `https://pkg-pr-registry-bridge.render.vip`

The package name selects the upstream package; the version pattern selects the
source:

```
@voidzero-dev/vite-plus-core@0.0.0-pr.1891       -> pkg.pr.new PR build
vite-plus@0.0.0-commit.a832a55                   -> pkg.pr.new commit build
vite-plus@0.2.1, react@latest                    -> npm registry
```

This makes a Bun alias override work through the bridge:

```json
{
  "overrides": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-pr.1891"
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
  pkg.pr.new tarball, rewrites `package/package.json` (name, version, preview
  dependencies), repacks, and serves it. Generated tarballs and the rewritten
  metadata are cached in R2; the first request per `(name, version)` builds and
  stores them, and the deploy-time warm step pre-populates them.
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

Guarded by `Authorization: Bearer <ADMIN_TOKEN>` (set `ADMIN_TOKEN` with
`wrangler secret put`). Without it configured the endpoints return 503.

```bash
# List configured refs (static env + runtime KV)
curl -H "authorization: Bearer $ADMIN_TOKEN" https://.../-/refs

# Register a ref at runtime (no redeploy). If GITHUB_TOKEN is set, the ref is
# verified to exist in voidzero-dev/vite-plus first.
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"ref":"commit.a832a55"}' https://.../-/refs

# Unregister a ref
curl -X DELETE -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"ref":"commit.a832a55"}' https://.../-/refs

# Purge a generated build from the caches (R2 + edge)
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"package":"vite-plus","version":"0.0.0-pr.1891"}' https://.../-/purge
```

A registered ref is reflected immediately and built into the packument on the
next request (and into R2 on first fetch). This is the no-redeploy path for
exposing new pkg.pr.new builds.

## Configuration

Set via `wrangler.toml` `[vars]` (tokens via `wrangler secret`):

| Var | Meaning |
| --- | --- |
| `PUBLIC_BASE_URL` | Public origin of the bridge; used in `dist.tarball` URLs. Must match the deployed route. |
| `NPM_REGISTRY` | npm fallback registry (`https://registry.npmjs.org`). |
| `PKG_PR_NEW_BASE` | pkg.pr.new base (`https://pkg.pr.new`). |
| `PREVIEW_OWNER` / `PREVIEW_REPO` | Fixed upstream repo (`voidzero-dev` / `vite-plus`). |
| `VITE_PLUS_PREVIEW_REFS` | Comma-separated refs to inject: `pr.<n>` / `commit.<sha>`. |
| `MAX_TARBALL_BYTES` | Max upstream tarball size (default 64 MiB). |

Bindings/secrets:

- `TARBALL_CACHE` (R2) - generated tarballs + rewritten metadata (incl. integrity).
- `PREVIEW_REFS` (KV) - runtime-registered refs.
- `ADMIN_TOKEN` (secret) - guards the admin endpoints.
- `GITHUB_TOKEN` (secret, optional) - enables PR/commit existence checks on `/-/refs`.

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
fallback, `pr.<n>`/`commit.<sha>` preview injection, tarball rewrite, R2 + edge
caching, deploy-time warm, computed SHA-512/SHA-1 integrity, KV-backed dynamic
refs, authenticated admin endpoints (`/-/refs`, `/-/purge`), optional GitHub
existence checks, and a bun end-to-end check. Remaining (MVP3): a pkg.pr.new
webhook to auto-register refs, more workspace packages via config, and metrics.
