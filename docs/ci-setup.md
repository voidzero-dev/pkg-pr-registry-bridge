# Wiring vite-plus CI to the registry bridge

Bridge: `https://registry-bridge.viteplus.dev`
Repo:   `voidzero-dev/vite-plus` (owner/repo are fixed in the Worker)

> Keep the real `ADMIN_TOKEN` in a password manager / Actions secret, not in the
> repo. On the bridge itself the same value is set with
> `void secret put ADMIN_TOKEN`.

## How it works

The bridge ships a reusable action that does the CPU-heavy work in CI: it packs
each locally built package directory with `pnpm pack` (resolving
`workspace:`/`catalog:` specs), rewrites `package/package.json` (name/version,
plus pinning deps between packages of the same batch to the synthetic commit
version), re-packs, hashes, `PUT`s the tarball, and immediately `POST`s that
package's metadata (`/-/publish`), so stored bytes and served metadata can
never diverge for longer than one package's upload. A final `POST /-/register`
registers the ref, flipping the whole version visible atomically; a run
cancelled mid-way leaves only invisible artifacts. The Worker then only serves
bytes from R2, with `dist.integrity` matching the exact bytes served.

The action reads everything from the local checkout: pkg.pr.new is not
involved, so the step works even when pkg.pr.new is down and can run on
commits that never publish there.

## Setup

### 1. Store the admin token as an Actions secret

In `voidzero-dev/vite-plus` -> Settings -> Secrets and variables -> Actions, add
`PKG_PR_BRIDGE_ADMIN_TOKEN` = the bridge's `ADMIN_TOKEN`.

### 2. Add the publish step to the workflow

In the job that assembles the build artifacts, after `pnpm install`, the
artifact downloads, and `publish-native-addons.ts --mode pkg-pr-new` (which
prepares `packages/cli/npm/*` and `packages/cli/cli-npm/*` on disk):

```yaml
- uses: voidzero-dev/pkg-pr-registry-bridge@main
  with:
    sha: ${{ github.event.pull_request.head.sha }}
    packages: |
      packages/cli
      packages/core
      packages/prompts
      packages/cli/npm/*
      packages/cli/cli-npm/*
    admin-token: ${{ secrets.PKG_PR_BRIDGE_ADMIN_TOKEN }}
    # Optional: surfaced by /-/refs. Omit/empty on push runs (no PR).
    pr-url: ${{ github.event.pull_request.html_url }}
    # bridge-url defaults to https://registry-bridge.viteplus.dev
```

The runner needs pnpm on `PATH` (pnpm/action-setup) and the workspace
installed (`pnpm install`), or `pnpm pack` cannot resolve `workspace:` specs.
Deps between the listed packages are pinned to the synthetic version, so a
package whose dep is missing from the list fails the run up front (before
anything uploads) rather than publishing a version with a dangling dep.

> Use `github.event.pull_request.head.sha`, not `github.sha`: on `pull_request`
> events `github.sha` is the ephemeral **merge** commit, whereas the checkout
> being packed is the PR **head** commit. On `push` events (no merge commit)
> `github.sha` is the head commit and is correct.

### 3. Verify

After a PR build publishes and the step runs:

```bash
curl https://registry-bridge.viteplus.dev/-/refs
```

## Notes

- To publish a commit by hand (same code path as the action), build a
  vite-plus checkout at that commit the way the workflow does, then run
  `PKG_PR_BRIDGE_ADMIN_TOKEN=… pnpm warm --repo <checkout> <sha>`.
- A long-lived PR accumulates one `commit.<sha>` ref per pushed commit. Purge
  stale ones with `POST /-/purge` if the packument grows too large.
