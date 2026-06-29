# pkg-pr-registry-bridge

A version-gated npm registry bridge that lets package managers install
[pkg.pr.new](https://pkg.pr.new) Vite+ preview builds using normal npm registry
semantics. Runs as a single Cloudflare Worker.

Live: `https://pkg-pr-registry-bridge.void.app`

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
- **Transitive deps**: a preview build's `optionalDependencies` point at
  pkg.pr.new (the platform binaries). The bridge rewrites those URLs to
  synthetic **version strings** (`0.0.0-commit.<sha>`) and serves packuments for
  those packages too, so they resolve through the bridge like the other preview
  packages, and the package manager downloads only the binary for the current
  platform (reading os/cpu from the packument) instead of all of them. The
  binaries are large (tens of MB), so they are repacked + hashed in CI (where
  there is no per-request limit) and uploaded; the binary's `package.json`
  version is rewritten to the synthetic version so it matches what the resolver
  expects (pnpm's strict store check rejects a mismatch). A platform binary not
  yet uploaded for a registered ref redirects to pkg.pr.new as a best-effort
  fallback. The small preview packages can also be built in-Worker on demand as a
  fallback (they are small enough to stay within the limits).
- **Publishing** (`POST /-/publish`, `PUT /-/tarball/...`): the
  [publish action](#publishing-from-ci) downloads each package from pkg.pr.new,
  rewrites + re-packs + hashes it, `PUT`s the bytes, and `POST`s the metadata
  (rewritten package.json + integrity) and registers the ref, all in one CI run.
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
registry = "https://pkg-pr-registry-bridge.void.app/"

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
runtime via the admin endpoint below (stored in a single R2 index object read
with a cheap `get`, not a rate-limited KV `list`), with no redeploy. Both
sources are merged.

## Admin endpoints

Writes are guarded by `Authorization: Bearer <ADMIN_TOKEN>` (set `ADMIN_TOKEN`
with `void secret put ADMIN_TOKEN`); without it configured the write endpoints
return 503. `GET /-/refs` is a public read.

```bash
# List configured refs (static env + runtime R2 index) - no auth required
curl https://.../-/refs

# Register a ref at runtime (no redeploy).
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"ref":"commit.a832a55"}' https://.../-/refs

# Unregister a ref
curl -X DELETE -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"ref":"commit.a832a55"}' https://.../-/refs

# Purge a generated build from the caches (R2 + edge)
curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" -H 'content-type: application/json' \
  -d '{"package":"vite-plus","version":"0.0.0-commit.a832a55"}' https://.../-/purge
```

Tarball upload (`PUT /-/tarball/<pkg>/<version>.tgz`) and publish
(`POST /-/publish`, stores metadata + registers the ref) are also admin-guarded;
they are driven by the [publish action](#publishing-from-ci), not by hand.

A registered ref is reflected immediately and built into the packument on the
next request (and into R2 on first fetch). This is the no-redeploy path for
exposing new pkg.pr.new builds.

### Publishing from CI

The heavy work (download, rewrite, re-pack, hash) runs in CI via a reusable
action, so the Worker only serves. Wire it into vite-plus's pkg.pr.new workflow:
see [`docs/ci-setup.md`](./docs/ci-setup.md). To publish by hand (same code
path), run `PKG_PR_BRIDGE_ADMIN_TOKEN=… pnpm warm <sha>`; with no arguments it
publishes the refs in `.env` (also part of `pnpm run deploy`).

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
| `VITE_PLUS_PREVIEW_REFS` | Comma-separated commit refs to inject: `commit.<sha>` (PR refs rejected). |
| `WORKSPACE_PACKAGES` | Allowlist for the tarball endpoint and pkg.pr.new-URL dep routing. Exact names or `prefix*`, e.g. `vite-plus,@voidzero-dev/vite-plus-*`. |
| `MAX_TARBALL_BYTES` | Max upstream tarball size (default 64 MiB). |

Bindings/secrets:

- `STORAGE` (R2) - generated tarballs, rewritten metadata (incl. integrity), and the runtime-registered refs index. Auto-provisioned by Void on deploy (no manual bucket creation); the binding is declared in `void.json` (`inference.bindings.storage`). The runtime refs index self-expires after 90 days (in-code TTL).
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

# Deploy, warm the caches, and run the end-to-end bun install check.
# Use `pnpm run deploy` (not `pnpm deploy`, which is pnpm's built-in command).
pnpm run deploy                          # void deploy + warm + e2e
```

`pnpm run deploy` runs `void deploy`, then `pnpm warm` (publishes the configured
preview refs into R2 via the action so installs are served from cache), then
`pnpm test:e2e` (a real `bun install` against the live bridge that asserts the
alias/override resolves to the synthetic version). Use `pnpm run deploy:only`
for `void deploy` alone.

The public origin (`PUBLIC_BASE_URL` in `.env.production`) is the Void platform
URL `https://pkg-pr-registry-bridge.void.app`. To serve from a custom domain
instead, run `void domain add <hostname>` (it prints the CNAME + ownership TXT to
add at your DNS provider) and set `PUBLIC_BASE_URL` to that host.

Pushes to `main` auto-deploy via `.github/workflows/deploy.yml` (`pnpm exec void
deploy`). Add a `VOID_TOKEN` repository secret (`void auth token` copies one to
your clipboard); `VOID_PROJECT` is pinned in the workflow.
