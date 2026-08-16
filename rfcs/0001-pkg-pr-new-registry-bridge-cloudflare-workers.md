# RFC 0001: pkg.pr.new Registry Bridge on Cloudflare Workers

- Status: Implemented (MVP1 + MVP2)
- Author: fengmk2
- Created: 2026-06-26
- Source design: `pkg-pr-new-registry-bridge-version-gated-design.md`
- Tracking repo: `pkg-pr-registry-bridge`

> Implementation note: the shipped bridge supports only immutable commit refs
> (`0.0.0-commit.<sha>`). PR-number refs (`0.0.0-pr.<n>`) shown in the examples
> below were dropped during implementation because a PR ref is mutable (it
> advances to newer commits), so its generated metadata/tarball could be
> overwritten and mismatch a consumer's lockfile. Read `pr.<n>` examples as
> historical design; use `commit.<sha>` for current behavior.

> Deployment note: the bridge has since migrated to the [Void](https://void.cloud)
> framework and deploys via `void deploy`; the wrangler / own-Cloudflare-account
> and `GITHUB_TOKEN` specifics below are historical. See [README.md](../README.md)
> for the current implementation and deployment.

> Serving-model note: the shipped bridge no longer builds or fetches preview
> tarballs at request time. The CPU/memory-heavy work (pack, rewrite, re-pack,
> hash) moved to a CI publish action that uploads finished artifacts to R2 (see
> [docs/ci-setup.md](../docs/ci-setup.md)); the Worker only streams bytes from
> R2, and a version whose bytes are not there is a 404. As a result the
> in-Worker on-demand build and the platform-binary redirect to pkg.pr.new
> described below, the `PKG_PR_NEW_BASE` and `MAX_TARBALL_BYTES` vars, and the
> `toPkgPrNewUrl` / `fetchUpstreamTarball` modules were all removed. Read the
> tarball-build sections (6.x), the upstream-fetch guard, and those vars as
> historical design; the Worker no longer reaches out to pkg.pr.new at all.

## 1. Summary

This RFC specifies how to implement the version-gated pkg.pr.new registry
bridge as a single Cloudflare Worker.

The bridge is an npm-compatible registry proxy. For a small allowlist of
Vite+ packages it injects synthetic preview versions (`0.0.0-pr.<n>`,
`0.0.0-commit.<sha>`) that resolve to pkg.pr.new preview builds, and it
falls back to `registry.npmjs.org` for everything else. The package name
selects the upstream package; the version pattern selects the source.

The source design document targets a Node.js/Bun server with a local
filesystem cache and the `tar` CLI. Cloudflare Workers have no filesystem,
no child processes, and a constrained CPU/memory budget. This RFC maps the
design onto Workers primitives: Hono for routing, the Web Streams
compression API plus a pure-JS tar codec for tarball rewriting, the Cache
API plus R2 for caching, and `wrangler` vars/bindings for configuration.

The end goal is unchanged: make this Bun override install correctly through
the bridge configured as the default registry.

```json
{
  "overrides": {
    "vite": "npm:@voidzero-dev/vite-plus-core@0.0.0-pr.1891"
  }
}
```

## 2. Motivation

pkg.pr.new exposes direct tarball URLs but not npm packument endpoints.
Bun/npm `overrides` and aliases (`vite` -> `npm:@voidzero-dev/vite-plus-core@<version>`)
need a real registry that answers `GET /<package>` with a packument and
`GET /<tarball>` with a tarball. The bridge supplies that missing layer
while preserving normal npm behavior for normal versions.

For the full product rationale, version-gating rules, and routing
semantics, see the source design document. This RFC does not restate them;
it specifies the Cloudflare Workers implementation.

## 3. Goals and Non-Goals

### 3.1 Goals

- Run the entire bridge as one Cloudflare Worker, deployable with `wrangler`.
- Serve packuments for the allowlisted packages with injected preview
  versions, and proxy all other packuments to npm unchanged.
- Generate preview tarballs by rewriting `package/package.json` of the
  upstream pkg.pr.new tarball, fully inside the Worker (no shell, no fs).
- Cache packuments and tarballs at the edge (Cache API) and durably (R2),
  with TTLs that respect mutable PR refs and immutable commit refs.
- Keep the supply-chain attack surface narrow: strict allowlist, strict
  ref validation, no arbitrary upstream URLs, tar path-traversal defense.

### 3.2 Non-Goals

Same as the source design: no generic pkg.pr.new proxy, no arbitrary
upstream URLs, no rewriting `latest` to a preview build, no renaming of
`@voidzero-dev/vite-plus-core` to `vite` inside the tarball. Additionally,
this RFC does not cover a multi-region origin or a self-hosted runtime;
Cloudflare's global edge is the deployment target.

## 4. Why Cloudflare Workers

- Globally distributed by default, low-latency for `bun install` from
  anywhere, no server to operate.
- First-class edge cache (Cache API) and object storage (R2) with zero
  egress fees between Workers and R2, which suits a tarball cache.
- `wrangler` gives reproducible config, secrets, and deploys.
- Native Web Streams `CompressionStream`/`DecompressionStream` and Web
  Crypto cover gzip and integrity hashing without native addons.

The trade-off is that the Node-centric parts of the source design (fs temp
dirs, `tar` CLI) must be replaced. Section 7 covers the constraints this
imposes and the mitigations.

## 5. Architecture Overview

```
                         bun / npm  install
                                |
                                v
                   +---------------------------+
                   |   Cloudflare Worker        |
                   |   (Hono router)            |
                   +---------------------------+
                    |        |          |       \
          packument |        | tarball  | purge  \ fallback
                    v        v          v         v
            +----------+ +----------+ +------+ +-------------------+
            | build    | | build    | | KV   | | proxy to          |
            | packument| | tarball  | |refs  | | registry.npmjs.org|
            +----------+ +----------+ +------+ +-------------------+
                  |            |
                  |            v
                  |     fetch pkg.pr.new tarball
                  |     -> DecompressionStream(gzip)
                  |     -> tar rewrite package.json
                  |     -> CompressionStream(gzip)
                  |
                  v
         +-------------------------------+
         | Caching tiers                 |
         |  - Cache API (caches.default) |  edge, response-level
         |  - R2 bucket (TARBALL_CACHE)  |  durable, generated tarballs
         |  - KV (optional, PREVIEW_REFS)|  dynamic preview-ref registry
         +-------------------------------+
```

Request classes:

1. Packument for an allowlisted preview package: fetch npm packument,
   inject configured preview versions, return.
2. Packument for any other package: pass through to npm.
3. Preview tarball (`/tarballs/...`): generate-or-serve-from-cache.
4. npm tarball or any other path: pass through to npm.
5. `POST /-/purge`: invalidate cache entries (MVP2+).

## 6. Detailed Design

### 6.1 Configuration and bindings

Configuration moves from `process.env` to Worker `env` bindings. Example
`wrangler.toml`:

```toml
name = "pkg-pr-registry-bridge"
main = "src/index.ts"
compatibility_date = "2026-06-01"
compatibility_flags = ["nodejs_compat"]

[vars]
PUBLIC_BASE_URL = "https://registry-bridge.example.com"
NPM_REGISTRY = "https://registry.npmjs.org"
PKG_PR_NEW_BASE = "https://pkg.pr.new"
PREVIEW_OWNER = "voidzero-dev"
PREVIEW_REPO = "vite-plus"
# MVP: static preview refs. Comma-separated `pr.<n>` / `commit.<sha>`.
VITE_PLUS_PREVIEW_REFS = "pr.1891"
# Tarball safety limit (bytes). Lower than the design's 200MB; see 7.2.
MAX_TARBALL_BYTES = "67108864"

[[r2_buckets]]
binding = "TARBALL_CACHE"
bucket_name = "pkg-pr-registry-bridge-tarballs"

# Optional, MVP2: dynamic preview-ref registry + purge state.
[[kv_namespaces]]
binding = "PREVIEW_REFS"
id = "<kv-namespace-id>"
```

`GITHUB_TOKEN` (for optional PR/commit existence checks in MVP2) is a
secret set with `wrangler secret put GITHUB_TOKEN`, never a plaintext var.

`compatibility_flags = ["nodejs_compat"]` is enabled so a pure-JS tar
library and `Buffer`-style helpers work, but the implementation must not
depend on `node:fs`, `node:child_process`, or any filesystem behavior.

The `Env` type is defined once and threaded through Hono:

```ts
export interface Env {
  PUBLIC_BASE_URL: string
  NPM_REGISTRY: string
  PKG_PR_NEW_BASE: string
  PREVIEW_OWNER: string
  PREVIEW_REPO: string
  VITE_PLUS_PREVIEW_REFS: string
  MAX_TARBALL_BYTES: string
  TARBALL_CACHE: R2Bucket
  PREVIEW_REFS?: KVNamespace
  GITHUB_TOKEN?: string
}
```

### 6.2 Routing

Hono on Workers. The router must accept three packument spellings plus the
tarball, purge, and catch-all fallback routes.

| Method | Path                                  | Handler            |
| ------ | ------------------------------------- | ------------------ |
| GET    | `/:pkg` (unscoped, e.g. `/vite-plus`) | packument          |
| GET    | `/@:scope/:pkg` (decoded scoped)      | packument          |
| GET    | `/@:scope%2f:pkg` (encoded scoped)    | packument          |
| GET    | `/tarballs/:pkg/:file`                | preview tarball    |
| GET    | `/tarballs/@:scope/:pkg/:file`        | preview tarball    |
| POST   | `/-/purge`                            | purge (MVP2)       |
| GET    | `/-/*` and any other path             | npm fallback proxy |

Implementation notes:

- npm clients request scoped packages as a single percent-encoded segment
  (`/@voidzero-dev%2Fvite-plus-core`). Normalize the package name early
  with `decodeURIComponent` and re-encode only when building outbound URLs.
- Tarball filenames are `<version>.tgz`; the version is parsed from the
  filename, the package name from the preceding segment(s).
- Because the bridge is the default registry, the catch-all proxy is
  essential: any path the bridge does not own is forwarded to npm.

### 6.3 Preview parsing and allowlist (shared with the design)

The pure functions from the source design are runtime-agnostic and used
verbatim:

```ts
export const PREVIEW_PACKAGES = new Set(['@voidzero-dev/vite-plus-core', 'vite-plus'])

export type PreviewRef = { type: 'pr'; ref: string } | { type: 'commit'; ref: string }

export function parsePreviewVersion(version: string): PreviewRef | null {
  const pr = version.match(/^0\.0\.0-pr\.(\d+)$/)
  if (pr) return { type: 'pr', ref: pr[1] }
  const commit = version.match(/^0\.0\.0-commit\.([0-9a-f]{7,40})$/i)
  if (commit) return { type: 'commit', ref: commit[1] }
  return null
}
```

`toPkgPrNewUrl` is parameterized by env instead of module constants so
owner/repo/base come from bindings:

```ts
export function toPkgPrNewUrl(env: Env, packageName: string, version: string) {
  const preview = parsePreviewVersion(version)
  if (!preview) return null
  return (
    `${env.PKG_PR_NEW_BASE}/${env.PREVIEW_OWNER}/${env.PREVIEW_REPO}` +
    `/${packageName}@${preview.ref}`
  )
}
```

Configured preview refs come from `parseConfiguredPreviewRefs(env.VITE_PLUS_PREVIEW_REFS)`
(MVP), or from KV merged with the env value (MVP2), producing
`{ type, ref, version, tag }[]`.

### 6.4 Packument endpoint

```
GET /vite-plus
GET /@voidzero-dev/vite-plus-core   (or %2F encoded)
```

Flow:

1. Normalize the package name.
2. `fetch(`${env.NPM_REGISTRY}/${encoded}`)` for the upstream packument,
   forwarding `Accept` (support the abbreviated
   `application/vnd.npm.install-v1+json` packument to reduce size).
3. If the package is not in `PREVIEW_PACKAGES`, stream the npm response
   straight back (see 6.6).
4. Otherwise parse JSON, then for each configured preview ref:
   - Read the upstream `package/package.json` for that ref (see 6.4.1).
   - Build version metadata: start from registry-safe fields of the
     upstream package.json, set `name`/`version`, rewrite preview
     dependencies, and set `dist.tarball` to
     `${PUBLIC_BASE_URL}/tarballs/${encodeURIComponent(name)}/${version}.tgz`.
   - Insert into `versions[version]` and `dist-tags[tag]`.
5. Leave existing `versions` and `latest` untouched. Return JSON with the
   cache headers from 6.8.

#### 6.4.1 Reading upstream package.json without a filesystem

The design reads `package/package.json` from an extracted temp dir. On
Workers we instead stream-parse the tarball and stop at that entry:

- `fetch` the pkg.pr.new tarball, pipe through `DecompressionStream('gzip')`.
- Feed the decompressed byte stream to a streaming tar reader; resolve as
  soon as the `package/package.json` entry is fully read, then abort the
  rest of the stream.

To avoid downloading the tarball twice (once for the packument's
package.json, once for the tarball endpoint), the first fetch generates and
stores the full rewritten tarball in R2 (6.7). The packument then reads the
already-rewritten `package.json` and, when integrity is enabled, the stored
tarball's hash from R2 metadata. This makes packument integrity and the
served tarball consistent by construction.

MVP1 simplification: if integrity is omitted (6.5), the packument only
needs the upstream `package.json`, so the early-exit stream read alone is
enough and tarball generation can stay lazy until the tarball endpoint is
hit.

### 6.5 Integrity and shasum

Generated tarballs differ from upstream, so upstream integrity must not be
reused. Hashing uses Web Crypto over the final gzip bytes:

```ts
async function digests(bytes: Uint8Array) {
  const [sha1, sha512] = await Promise.all([
    crypto.subtle.digest('SHA-1', bytes),
    crypto.subtle.digest('SHA-512', bytes),
  ])
  return {
    shasum: hex(sha1), // dist.shasum
    integrity: `sha512-${base64(sha512)}`, // dist.integrity (SRI)
  }
}
```

- MVP1: omit `dist.integrity` and `dist.shasum`. npm/bun compute and pin
  integrity from the downloaded tarball; installs still succeed. Never emit
  a wrong value.
- MVP2+: compute from the generated bytes and store on the R2 object's
  custom metadata, so the packument can advertise integrity without
  re-hashing.

### 6.6 npm fallback proxy

Two fallback cases:

- Non-allowlisted package: proxy packument and tarball to npm unchanged.
- Allowlisted package, normal (non-preview) version: serve the npm
  packument with preview versions injected; normal-version tarball URLs in
  that packument still point at npm and are fetched directly by the client
  (or pass through the bridge to npm). The bridge never rewrites `latest`.

Proxy implementation:

```ts
async function proxyToNpm(env: Env, req: Request, path: string) {
  const upstream = new Request(`${env.NPM_REGISTRY}${path}`, {
    method: 'GET',
    headers: filterHopByHop(req.headers),
  })
  const res = await fetch(upstream, { cf: { cacheEverything: false } })
  // Stream body straight through; preserve content-type and caching.
  return new Response(res.body, { status: res.status, headers: res.headers })
}
```

Because Cloudflare follows redirects and npm sometimes 301s tarball hosts,
the proxy follows redirects by default. Hop-by-hop and `host` headers are
stripped before forwarding.

### 6.7 Preview tarball endpoint

```
GET /tarballs/vite-plus/0.0.0-pr.1891.tgz
GET /tarballs/@voidzero-dev/vite-plus-core/0.0.0-pr.1891.tgz
```

Flow (Workers-native rewrite of the design's extract/repack):

1. Parse package name + synthetic version from the path; reject if the
   package is not in `PREVIEW_PACKAGES` (404) or the version is not a valid
   preview (400).
2. Cache lookup: Cache API first, then R2 by key `tarball:<name>:<version>`.
   On hit, stream the cached tarball back.
3. Miss: build the pkg.pr.new URL, `fetch` the upstream `.tgz`, enforcing
   `MAX_TARBALL_BYTES` while reading.
4. `DecompressionStream('gzip')` -> streaming tar reader -> for each entry:
   - `package/package.json`: parse, run `rewritePackageJson` (set
     name/version, rewrite preview deps/peerDeps/optionalDeps), re-emit with
     a recomputed tar header (new size/checksum).
   - any other entry: validate the path (6.9) and pass through unchanged.
5. Streaming tar writer -> `CompressionStream('gzip')` -> the final body.
6. Tee the output: one branch to the client `Response`, one branch buffered
   for R2 `put` (with integrity metadata when enabled), scheduled via
   `ctx.waitUntil` so the client is not blocked on the write.
7. Set cache headers per 6.8.

Because only one small file changes, the rewrite is a streaming transform:
all large binary entries pass through without being buffered, keeping peak
memory near the size of `package.json` plus codec windows. See 7.2.

`rewritePackageJson` and `rewritePreviewDependencies` are reused verbatim
from the source design.

### 6.8 Caching

Three tiers:

- Cache API (`caches.default`): response-level edge cache keyed by the
  request URL. Populated on read, honored before any compute.
- R2 (`TARBALL_CACHE`): durable store for generated tarballs so a cold edge
  does not re-download and re-rewrite from pkg.pr.new. Keys:
  `tarball/<name>/<version>.tgz`. Commit-ref objects are written once and
  treated as immutable; PR-ref objects carry a short freshness window.
- KV (`PREVIEW_REFS`, MVP2): dynamic list of preview refs to inject, and
  purge bookkeeping, so adding a ref does not require a redeploy.

Header policy mirrors the design:

```
PR refs (mutable):     Cache-Control: public, max-age=300        (5 min)
Commit refs (stable):  Cache-Control: public, max-age=31536000, immutable
ETag:                  "<name>-<version>-<contentHash>"
```

Packument cache key incorporates a hash of the configured preview refs so a
ref change naturally produces a new cached entry:
`packument:<name>:<refsHash>`.

`ctx.waitUntil` is used to populate Cache API and R2 after the response is
returned, so cache writes never add latency to the install.

### 6.9 Security

The Worker enforces the design's restrictions at the edge:

- Owner/repo are fixed by env (`voidzero-dev/vite-plus`); request input
  never selects them.
- Only `PREVIEW_PACKAGES` receive synthetic versions; all else proxies.
- Ref validation: PR `^[0-9]+$`, commit `^[0-9a-f]{7,40}$/i`. No arbitrary
  upstream URLs, ever.
- Tar safety on every passthrough entry: reject absolute paths, `..`
  segments, and anything outside `package/`. Enforce `MAX_TARBALL_BYTES`
  while reading the upstream stream and abort on overflow. Reject a tarball
  with no `package/package.json`.
- `POST /-/purge` (MVP2) requires an auth token (secret) and only accepts a
  `{ package, version }` body within the allowlist.

### 6.10 Purge endpoint (MVP2)

```
POST /-/purge   { "package": "...", "version": "0.0.0-pr.1891" }
```

Validates the body against the allowlist, deletes the R2 object, and calls
`caches.default.delete` for the corresponding tarball and packument URLs.
Authenticated via a bearer secret.

## 7. Workers Constraints and Mitigations

### 7.1 No filesystem / no child process

The design's temp-dir extraction and `tar` CLI are replaced by in-Worker
streaming codecs:

- gzip: native `DecompressionStream`/`CompressionStream`.
- tar: a pure-JS streaming reader/writer (see 8). No `node:fs`, no
  `execFile('tar')`.

### 7.2 CPU and memory limits

- Memory is ~128 MB per isolate, so buffering a 200 MB tarball fully (the
  design's max) is not viable. Mitigation: stream the rewrite so only
  `package/package.json` is buffered; pass through all other entries. Set
  `MAX_TARBALL_BYTES` to a conservative default (64 MB) and make it a var.
- CPU time is bounded per request. gzip recompression of a large tarball is
  the main cost; R2 caching means it runs at most once per (name, version)
  per region, amortized across all installs.
- Worst case (cold edge + cold R2 + very large tarball) should fail safe
  with a clear 5xx rather than silently truncate.

### 7.3 Subrequest and response limits

- Each preview tarball generation makes a small number of subrequests (npm
  packument, pkg.pr.new tarball, R2, Cache API), well within limits.
- The tee-to-R2 write happens in `ctx.waitUntil`, decoupled from the client
  response lifetime.

### 7.4 Configuration updates

Changing `VITE_PLUS_PREVIEW_REFS` in `[vars]` requires `wrangler deploy`.
MVP2 moves the ref list to KV so it can be updated without redeploying and
purged via the purge endpoint.

## 8. Library and Runtime Choices

- HTTP router: Hono (first-class Workers support, tiny, typed `env`).
- gzip: native Web Streams compression API (no dependency).
- tar: a pure-JS, dependency-free streaming tar codec that runs on Workers
  (e.g. `nanotar`, or a vendored minimal reader/writer). Requirement: it
  must not touch `node:fs` and must support streaming so large entries are
  not fully buffered. This is the single most important library decision
  and will be validated with a spike before committing.
- hashing: Web Crypto `crypto.subtle` (SHA-1, SHA-512).
- storage: R2 binding + Cache API + optional KV.

## 9. Project Structure

Adapted from the design's layout for a Worker entrypoint:

```
src/
  index.ts                  # Hono app, route table, fetch handler
  config.ts                 # Env typing, parse vars, base URLs
  registry/
    parsePackageName.ts
    fetchNpmPackument.ts
    buildPackument.ts
    buildVersionMetadata.ts
    proxyToNpm.ts
  preview/
    parsePreviewVersion.ts
    parseConfiguredPreviewRefs.ts
    toPkgPrNewUrl.ts
    packages.ts             # PREVIEW_PACKAGES
  tarball/
    fetchUpstreamTarball.ts # fetch + size guard
    streamRewriteTarball.ts # gunzip -> tar rewrite -> gzip
    rewritePackageJson.ts
    digests.ts              # SHA-1 / SHA-512 SRI
  cache/
    cacheKey.ts
    edgeCache.ts            # caches.default helpers
    r2Cache.ts             # R2 get/put with metadata
    kvRefs.ts              # MVP2 dynamic refs
  security/
    validateTarballPath.ts
    limits.ts
    auth.ts                # purge auth
wrangler.toml
test/                       # vitest + @cloudflare/vitest-pool-workers
```

## 10. Testing Strategy

- Unit tests for the pure functions (`parsePreviewVersion`,
  `parseConfiguredPreviewRefs`, `toPkgPrNewUrl`, `rewritePackageJson`,
  `validateTarballPath`) run as plain vitest.
- Integration tests run inside the Workers runtime via
  `@cloudflare/vitest-pool-workers` (Miniflare), with R2/KV bindings mocked
  by the pool and `fetch` to npm/pkg.pr.new stubbed with fixtures.
- A golden tarball fixture (a real pkg.pr.new vite-plus build) verifies the
  rewrite: `package/package.json` name/version/deps rewritten, all other
  entries byte-identical, and the repacked tar is valid gzip+tar.
- End-to-end smoke test mirrors the design's validation flow: point a
  scratch project's `bunfig.toml` at a `wrangler dev` URL, run `bun install`,
  and assert the `node_modules/*/package.json` name/version expectations.

## 11. Deployment and CI

- `wrangler deploy` from CI on the default branch; `wrangler dev` for local.
- Create the R2 bucket and (MVP2) KV namespace via `wrangler` before first
  deploy.
- Secrets (`GITHUB_TOKEN`, purge token) via `wrangler secret put`.
- A custom domain/route maps `registry-bridge.example.com` to the Worker;
  `PUBLIC_BASE_URL` must match it so `dist.tarball` URLs are correct.

## 12. Phased Plan (mapped to the design's MVPs)

MVP1 (default registry + PR refs, no integrity):

- Hono app, packument inject for `pr.<n>`, npm fallback proxy.
- Streaming tarball rewrite, R2 + Cache API caching.
- `dist.integrity`/`shasum` omitted.

MVP2 (commit refs, dist-tags, validation, purge):

- `commit.<sha>` refs with immutable caching.
- Preview dist-tags (`pr-1891`, `commit-a832a55`).
- GitHub API existence checks (PR/commit) using a secret token.
- KV-backed dynamic refs and authenticated `POST /-/purge`.
- Computed SHA-512 integrity / SHA-1 shasum stored in R2 metadata.

MVP3 (scale/extras):

- More Vite+ workspace packages via config.
- GitHub webhook-driven cache invalidation.
- Health/metrics endpoint and structured logging (Workers Analytics /
  Logpush).

## 13. Open Questions

1. tar codec: confirm a streaming, fs-free library handles real vite-plus
   tarballs within CPU/memory limits, or vendor a minimal one.
2. Integrity timing: advertise integrity in MVP1 (requires generating the
   tarball during packument build) or defer to MVP2 as written here.
3. pkg.pr.new tarball URL shape and redirects: confirm the
   `name@<ref>` form resolves to a single fetchable `.tgz`.
4. Abbreviated vs full packument: ensure both `Accept` variants are handled
   so all package managers resolve correctly.
5. Max tarball size: pick the production `MAX_TARBALL_BYTES` from the actual
   size distribution of vite-plus preview builds.

## 14. Appendix: Workers-adapted code sketches

Packument handler (integrity-deferred MVP1 path):

```ts
app.get('/:pkg{.+}', async (c) => {
  const name = normalizePackageName(c.req.param('pkg'))
  const npmRes = await fetch(`${c.env.NPM_REGISTRY}/${encode(name)}`, {
    headers: { accept: c.req.header('accept') ?? 'application/json' },
  })
  if (!PREVIEW_PACKAGES.has(name)) {
    return new Response(npmRes.body, npmRes) // pass-through
  }
  const packument = await npmRes.json()
  const refs = parseConfiguredPreviewRefs(c.env.VITE_PLUS_PREVIEW_REFS)
  packument['dist-tags'] ||= {}
  packument.versions ||= {}
  for (const ref of refs) {
    const pkgJson = await readUpstreamPackageJson(c.env, name, ref) // stream early-exit
    packument.versions[ref.version] = buildPreviewVersionMetadata({
      env: c.env,
      packageName: name,
      version: ref.version,
      upstreamPackageJson: pkgJson,
    })
    packument['dist-tags'][ref.tag] = ref.version
  }
  return json(packument, cacheHeadersForRefs(refs))
})
```

Streaming tarball rewrite (shape):

```ts
export async function streamRewriteTarball(
  upstream: ReadableStream<Uint8Array>,
  packageName: string,
  version: string,
): Promise<ReadableStream<Uint8Array>> {
  const entries = readTarEntries(upstream.pipeThrough(new DecompressionStream('gzip')))
  const out = createTarWriter()
  ;(async () => {
    for await (const entry of entries) {
      validateTarballPath(entry.name)
      if (entry.name === 'package/package.json') {
        const pkg = JSON.parse(await entry.text())
        const rewritten = rewritePackageJson(pkg, packageName, version)
        out.add('package/package.json', `${JSON.stringify(rewritten, null, 2)}\n`)
      } else {
        out.passthrough(entry) // header + body, not buffered
      }
    }
    out.end()
  })()
  return out.readable.pipeThrough(new CompressionStream('gzip'))
}
```
