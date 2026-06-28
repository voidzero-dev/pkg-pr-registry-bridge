# Wiring vite-plus CI to the registry bridge

Bridge: `https://pkg-pr-registry-bridge.render.vip`
Repo:   `voidzero-dev/vite-plus` (owner/repo are fixed in the Worker)

> Keep the real `ADMIN_TOKEN` in a password manager / Actions secret, not in the
> repo.

## How it works

The bridge ships a reusable action that does the CPU-heavy work in CI: for each
package (the two preview packages and every platform binary in vite-plus's
`optionalDependencies`) it downloads the pkg.pr.new build, rewrites
`package/package.json` (name/version, plus deps for the preview packages),
re-packs, hashes, `PUT`s the tarball, then `POST`s the metadata and registers the
ref. The Worker then only serves bytes from R2, with `dist.integrity` matching the
exact bytes served.

## Setup

### 1. Store the admin token as an Actions secret

In `voidzero-dev/vite-plus` -> Settings -> Secrets and variables -> Actions, add
`PKG_PR_BRIDGE_ADMIN_TOKEN` = the bridge's `ADMIN_TOKEN`.

### 2. Add the publish step to the pkg.pr.new workflow

Right after the pkg.pr.new build publishes:

```yaml
- uses: voidzero-dev/pkg-pr-registry-bridge@main
  with:
    sha: ${{ github.event.pull_request.head.sha }}
    admin-token: ${{ secrets.PKG_PR_BRIDGE_ADMIN_TOKEN }}
    # bridge-url defaults to https://pkg-pr-registry-bridge.render.vip
```

> Use `github.event.pull_request.head.sha`, not `github.sha`. pkg.pr.new publishes
> under the PR **head** commit, whereas on `pull_request` events `github.sha` is
> the ephemeral **merge** commit; publishing that would point at a SHA pkg.pr.new
> never built. On `push` events (no merge commit) `github.sha` is the head commit
> and is correct.

### 3. Verify

After a PR build publishes and the step runs:

```bash
curl https://pkg-pr-registry-bridge.render.vip/-/refs
```

## Notes

- To publish a commit by hand (same code path as the action), run
  `PKG_PR_BRIDGE_ADMIN_TOKEN=… pnpm warm <sha>`.
- A long-lived PR accumulates one `commit.<sha>` ref per pushed commit. Purge
  stale ones with `POST /-/purge` if the packument grows too large.
- Enable strict ref validation by setting `GITHUB_TOKEN` (read access to the
  repo): `POST /-/refs` then rejects refs that do not exist in the repo.
