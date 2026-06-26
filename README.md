# pkg-pr-registry-bridge

A version-gated npm registry bridge that lets package managers install
[pkg.pr.new](https://pkg.pr.new) Vite+ preview builds using normal npm registry
semantics. Runs as a single Cloudflare Worker.

The package name selects the upstream package; the version pattern selects the
source:

```
@voidzero-dev/vite-plus-core@0.0.0-pr.1891   -> pkg.pr.new PR build
vite-plus@0.0.0-commit.a832a55               -> pkg.pr.new commit build
vite-plus@0.2.1, react@latest                -> npm registry (unchanged)
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
for the full design and the source design doc it implements.

## How it works

- **Packument** (`GET /vite-plus`, `GET /@voidzero-dev/vite-plus-core`): fetches
  the npm packument (or synthesizes an empty one if the package is not on npm),
  injects the configured preview versions, and leaves existing versions and
  `latest` untouched. Non-allowlisted packages are proxied to npm verbatim.
- **Tarball** (`GET /tarballs/<pkg>/<version>.tgz`): downloads the upstream
  pkg.pr.new tarball, rewrites `package/package.json` (name, version, preview
  dependencies), repacks, and serves it. Generated tarballs are cached in R2 and
  at the edge.
- **Everything else**: proxied to `registry.npmjs.org`.

Only `@voidzero-dev/vite-plus-core` and `vite-plus` receive synthetic preview
versions (strict allowlist). Owner/repo are fixed to `voidzero-dev/vite-plus`.

## Configuration

Set via `wrangler.toml` `[vars]` (or `wrangler secret` for tokens):

| Var | Meaning |
| --- | --- |
| `PUBLIC_BASE_URL` | Public origin of the bridge; used in `dist.tarball` URLs. Must match the deployed route. |
| `NPM_REGISTRY` | npm fallback registry (`https://registry.npmjs.org`). |
| `PKG_PR_NEW_BASE` | pkg.pr.new base (`https://pkg.pr.new`). |
| `PREVIEW_OWNER` / `PREVIEW_REPO` | Fixed upstream repo (`voidzero-dev` / `vite-plus`). |
| `VITE_PLUS_PREVIEW_REFS` | Comma-separated refs to inject: `pr.<n>` / `commit.<sha>`, e.g. `pr.1891,commit.a832a55`. |
| `MAX_TARBALL_BYTES` | Max upstream tarball size (default 64 MiB). |

The `TARBALL_CACHE` R2 bucket binding stores generated tarballs and rewritten
metadata.

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

# Configure the preview refs to expose, then deploy
pnpm deploy
```

Point a Bun project at the bridge:

`bunfig.toml`

```toml
[install]
registry = "https://your-registry-bridge.example.com/"
```

`package.json`

```json
{
  "devDependencies": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-pr.1891",
    "@voidzero-dev/vite-plus-core": "0.0.0-pr.1891",
    "vite-plus": "0.0.0-pr.1891"
  },
  "overrides": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-pr.1891"
  }
}
```

## Status

MVP1 of the RFC is implemented: default-registry proxy with npm fallback,
`pr.<n>` and `commit.<sha>` preview injection, tarball rewrite, and R2 + edge
caching. Integrity fields are intentionally omitted (npm/bun compute them from
the downloaded tarball). MVP2 items (KV-backed dynamic refs, authenticated
purge endpoint, GitHub existence checks, computed integrity) are scoped in the
RFC but not yet built.
