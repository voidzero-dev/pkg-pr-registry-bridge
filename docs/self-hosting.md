# Deploy your own registry bridge

This repository is configured for [`voidzero-dev/vite-plus`](https://github.com/voidzero-dev/vite-plus),
but the bridge reads its upstream repo, package allowlist, and public origin from
configuration. Any open-source project that publishes [pkg.pr.new](https://pkg.pr.new)
preview builds (or builds package directories in CI) can run its own bridge.

Each step below shows the vite-plus value (the one committed here) next to the
equivalent for a hypothetical example project, so you can see what to swap:

| | vite-plus (this repo) | Example project |
| --- | --- | --- |
| GitHub repo | `voidzero-dev/vite-plus` | `acme-corp/acme-bundler` |
| Main package | `vite-plus` | `acme-bundler` |
| Meta/alias package | `@voidzero-dev/vite-plus-core` | `@acme/bundler-core` |
| Platform binaries | `@voidzero-dev/vite-plus-*` | `@acme/bundler-*` |
| Public origin | `https://registry-bridge.viteplus.dev` | `https://registry-bridge.acme.dev` |

Read [`../README.md`](../README.md) first for how the bridge works and why it
only serves immutable `0.0.0-commit.<sha>` builds. This guide assumes that
background and focuses on the deployment.

## Prerequisites

- **An upstream repo** that produces installable package directories in CI (a
  `pnpm pack`-able `package/` with a `package.json`). The publish action packs
  from the local checkout, so the bridge does not depend on pkg.pr.new.
- **A [Void](https://void.cloud) account** (`npm i -g void`, or use the pinned
  dev dependency via `pnpm exec void`). Void provisions the Worker plus the R2
  and KV bindings with no Cloudflare account. If you would rather run on raw
  Cloudflare Workers, see [Not using Void?](#not-using-void) at the end.
- **Node 24 and pnpm 11** (this repo's `devEngines`), plus **bun** if you want to
  run the `test:e2e` install check.

## What is project-specific

You change configuration and CI wiring only; the `src/` code stays as-is when you
point the bridge at a different project.

| Knob | Where | vite-plus value | Change to |
| --- | --- | --- | --- |
| `PREVIEW_OWNER` | `.env` | `voidzero-dev` | your GitHub org/user |
| `PREVIEW_REPO` | `.env` | `vite-plus` | your repo name |
| `WORKSPACE_PACKAGES` | `.env` | `vite-plus,@voidzero-dev/vite-plus-*` | your package names/prefixes |
| `PUBLIC_BASE_URL` | `.env.production` | `https://registry-bridge.viteplus.dev` | your deployed origin |
| Void project slug | workflows, `package.json`, `.void/` | `pkg-pr-registry-bridge` | your project name |
| Publish action `packages` | your upstream CI workflow | vite-plus layout | your built package dirs |
| Publish action `workspace-packages` | your upstream CI workflow | `vite-plus,@voidzero-dev/vite-plus-*` | match `WORKSPACE_PACKAGES` |
| Smoke/e2e assertions | `scripts/smoke-test.mjs`, `scripts/e2e-bun.mjs` | vite-plus packages | your packages (optional) |

## 1. Fork and install

```bash
git clone https://github.com/acme-corp/registry-bridge.git   # your fork
cd registry-bridge
pnpm install            # also runs `void prepare` (generates .void/ types)
pnpm typecheck
pnpm test               # vitest in workerd (Miniflare), no network/secrets
```

## 2. Point the bridge at your repo (`.env`)

`.env` is committed (non-secret) and loaded into the Worker's vars. Edit the
three project knobs:

```ini
PREVIEW_OWNER=acme-corp
PREVIEW_REPO=acme-bundler
# Packages the tarball endpoint serves. Exact names or `prefix*` patterns,
# comma-separated.
WORKSPACE_PACKAGES=acme-bundler,@acme/bundler-*
```

Leave `NPM_REGISTRY` as it is unless you have a reason to change it.
`PUBLIC_BASE_URL` in `.env` stays the local dev origin
(`http://localhost:5173`); the production value comes next.

**About `WORKSPACE_PACKAGES`.** This strict allowlist gates the tarball endpoint:
a name outside it 404s there. Include your main package, the alias/meta package a
consumer overrides `npm:...` to, and a `prefix*` for the per-platform binary
packages.

## 3. Set the public origin (`.env.production`)

`.env.production` overrides only the host-specific origin for `void deploy`:

```ini
PUBLIC_BASE_URL=https://registry-bridge.acme.dev
```

`PUBLIC_BASE_URL` is baked into every generated `dist.tarball` URL, so it **must**
match the origin package managers reach the bridge on. If you deploy
first and attach a custom domain later (step 6), set this to the Void platform
URL initially (`https://<your-slug>.void.app`) and update it when the domain is
live.

## 4. Choose your Void project slug

vite-plus uses two Void projects: `pkg-pr-registry-bridge` (production) and
`pkg-pr-registry-bridge-staging` (per-PR smoke tests). Pick your own slug (for
example `acme-registry-bridge`) and update the references that name it:

- `package.json` -> `deploy:staging` script
- `.github/workflows/staging.yml` (project name + `.void.app` smoke URL)
- `.github/workflows/void-deploy.yml` (staging project, `.void.app` smoke URL,
  and `VOID_PROJECT`)

The production slug is written to `.void/project.json` on your first deploy
(that directory is gitignored), so you do not edit it by hand.

If you do not want a separate staging environment yet, you can start with a
single project and simplify the workflows (see step 8); the two-project setup is
the recommended end state because it smoke-tests the real runtime before
production ships.

## 5. Deploy to Void

```bash
# One-time: authenticate and set the admin secret on the project.
void auth login
void secret put ADMIN_TOKEN        # guards the admin write endpoints

# Deploy. `pnpm run deploy` also runs the bun e2e check, which asserts
# vite-plus packages; use deploy:only until you have adapted that check (step 7).
pnpm run deploy:only               # = void deploy
```

On the first `void deploy`, Void provisions the Worker and the `STORAGE` (R2)
and `KV` bindings declared in `void.json`, and writes the project link to
`.void/`. Generate a strong random `ADMIN_TOKEN` (for example
`openssl rand -hex 32`) and keep it in a password manager; you will also add it
to your upstream repo's CI secrets in step 8.

Verify the deploy:

```bash
curl https://<your-slug>.void.app/_health
curl https://<your-slug>.void.app/-/refs      # public read; empty until you publish
```

## 6. Attach a custom domain (optional)

```bash
void domain add registry-bridge.acme.dev
```

Then set `PUBLIC_BASE_URL` in `.env.production` to the custom origin and redeploy
so generated tarball URLs point at it. The underlying `<slug>.void.app` URL keeps
working too.

## 7. Adapt the deploy-time checks (optional but recommended)

`scripts/smoke-test.mjs` and `scripts/e2e-bun.mjs` hardcode vite-plus package
names and paths. They still exercise generic bridge behavior, but to assert your
own packages:

- **`scripts/smoke-test.mjs`**: the packument check fetches `/vite-plus` and the
  download checks use `voidzero-dev/vite-plus@<sha>`. Point these at your main
  package and `PREVIEW_OWNER/PREVIEW_REPO`. The `--write` admin lifecycle uses a
  throwaway `commit.e2e<...>` ref and cleans up after itself; update the package
  name it publishes.
- **`scripts/e2e-bun.mjs`**: rewrite the `npm:@voidzero-dev/vite-plus-core@...`
  alias/override and the asserted package list to your packages, and point it at
  a `<sha>` your bridge already serves.

The CI workflows run the smoke test against the real runtime as their gate, so
keep it meaningful for your packages. It catches platform-only failures the
`pool-workers` unit tests cannot emulate (a real incident here: the Void runtime
forbids `caches.default`, which 500'd every packument while every unit test
stayed green).

## 8. Wire your upstream project's CI to publish

The bridge ships a reusable GitHub Action (this repo's root `action.yml`, bundle
committed under `.github/actions/publish-preview/dist/`) that does the CPU-heavy
work in the same CI job that built your artifacts: `pnpm pack` each package
directory (resolving `workspace:`/`catalog:` specs), rewrite `package.json`
(name/version, pin deps between packages of the same batch to the synthetic
commit version), re-pack, hash, `PUT` the tarball, `POST` the metadata, and
finally register the ref. The Worker then only serves bytes, with
`dist.integrity` computed over them.

In your **upstream repo** (`acme-corp/acme-bundler`):

1. **Add the admin token secret.** Settings -> Secrets and variables -> Actions,
   add `PKG_PR_BRIDGE_ADMIN_TOKEN` = the `ADMIN_TOKEN` you set in step 5.

2. **Add the publish step** to the job that assembles build artifacts, after
   `pnpm/action-setup`, `pnpm install`, and whatever prepares your per-platform
   package directories on disk:

   ```yaml
   - uses: acme-corp/registry-bridge@main        # your bridge fork
     with:
       sha: ${{ github.event.pull_request.head.sha }}
       admin-token: ${{ secrets.PKG_PR_BRIDGE_ADMIN_TOKEN }}
       bridge-url: https://registry-bridge.acme.dev
       # Your built package directories, newline/comma-separated. A trailing
       # "/*" expands to every direct subdirectory with a package.json.
       packages: |
         packages/cli
         packages/core
         packages/cli/npm/*
       # Must match the bridge's WORKSPACE_PACKAGES.
       workspace-packages: acme-bundler,@acme/bundler-*
       # Optional: surfaced by /-/refs; omit on push runs (no PR).
       pr-url: ${{ github.event.pull_request.html_url }}
   ```

   Notes:
   - The runner needs pnpm on `PATH` and the workspace installed
     (`pnpm install`), or `pnpm pack` cannot resolve `workspace:` specs.
   - Use `github.event.pull_request.head.sha`, not `github.sha`: on
     `pull_request` events `github.sha` is the ephemeral **merge** commit, but
     the checkout you pack is the PR **head**. On `push` events `github.sha` is
     the head commit and is correct.
   - Deps between the published packages are pinned to the synthetic version, so
     a package whose dep is missing from the batch fails the run up front,
     before anything uploads, rather than publishing a dangling dep.
   - `packages` and `workspace-packages` default to the vite-plus layout; set
     both for your project.

3. **Publish by hand** (same code path, for a one-off or backfill): build your
   repo's checkout at the commit the way CI does, then from the bridge repo run

   ```bash
   PKG_PR_BRIDGE_ADMIN_TOKEN=… pnpm warm --repo <built-checkout> \
     --packages "packages/cli,packages/core,packages/cli/npm/*" <sha>
   ```

## 9. Verify end to end

After an upstream PR build runs the publish step:

```bash
# The ref shows up immediately (no redeploy).
curl https://registry-bridge.acme.dev/-/refs

# The packument lists the synthetic version.
curl https://registry-bridge.acme.dev/acme-bundler | jq '.versions | keys'
```

Then point a throwaway consumer at the bridge and install (see the root README's
"Consumer configuration" section; set `registry` in `bunfig.toml`/`.npmrc` to
your origin and pin `0.0.0-commit.<sha>`).

## Automated deploys (GitHub OIDC + staging)

The committed workflows give a two-stage pipeline you can adopt as-is after
renaming the slugs:

- **`.github/workflows/staging.yml`** (every non-fork PR): deploys the PR to the
  staging project and runs the smoke test against the real runtime. Make its
  `Staging` job a required status check so a failing smoke test blocks the merge.
- **`.github/workflows/void-deploy.yml`** (push to `main`): re-runs staging as a
  gate, then deploys production and smoke-tests it.

Two authentication paths:

- **Push to main uses GitHub OIDC**, no long-lived token. Connect the repo once
  per project so the platform will exchange an OIDC token for a short-lived,
  project-scoped deploy token:

  ```bash
  void github connect acme-registry-bridge \
    --repo acme-corp/registry-bridge --branch main --executor github_actions
  ```

  The platform only honors that exchange from a workflow named `void-deploy.yml`
  on a push to the connected branch, so keep that filename.

- **PR staging uses a `VOID_TOKEN` secret.** The OIDC exchange is refused for
  `pull_request` events (they run untrusted code), so the staging deploy needs a
  repository secret `VOID_TOKEN` (`void auth token` copies one to your
  clipboard). Also add `STAGING_ADMIN_TOKEN` (the staging project's own
  `ADMIN_TOKEN`) so the `--write` smoke lifecycle can run.

Fork PRs cannot read those secrets, so `staging.yml` skips them and they get
only `ci.yml` (typecheck + test); the push-to-main gate re-runs staging so
production never ships on an unverified change.

## Ongoing maintenance

- **Refs index self-expires** after 90 days (in-code TTL). A daily Void cron
  (`crons/cleanup-expired.ts`) sweeps the per-version tarball/metadata objects
  once a ref's TTL lapses, so R2 stays bounded to the active-ref window.
- **A long-lived PR** accumulates one `commit.<sha>` ref per pushed commit. If a
  packument grows too large, purge stale ones:

  ```bash
  curl -X POST -H "authorization: Bearer $ADMIN_TOKEN" \
    -H 'content-type: application/json' \
    -d '{"package":"acme-bundler","version":"0.0.0-commit.<sha>"}' \
    https://registry-bridge.acme.dev/-/purge
  ```

- **Action bundle staleness**: if you edit the action or any module it imports,
  run `pnpm build:action` and commit the regenerated
  `.github/actions/publish-preview/dist/`. CI (`ci.yml`) fails if the committed
  bundle drifts.

## Not using Void?

The Worker is a standard Hono app (`src/app.ts`) fronted by the `routes/` layer;
Void only provides the platform, the R2/KV bindings, and the deploy CLI. To run
on raw Cloudflare Workers instead, provide the equivalent `wrangler.jsonc` (an
R2 bucket bound as `STORAGE`, a KV namespace bound as `KV`, the `env.ts` vars as
`[vars]`, and `ADMIN_TOKEN` as a secret) and deploy with `wrangler deploy`. The
application code does not depend on Void at runtime; the `.env` and publish
action described above carry over unchanged.
