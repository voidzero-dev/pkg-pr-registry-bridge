# Wiring vite-plus CI to the registry bridge

Bridge: `https://registry-bridge.viteplus.dev`
Repo:   `voidzero-dev/vite-plus` (owner/repo are fixed in the Worker)

vite-plus publishes preview builds with a GitHub Actions OIDC token, so it
stores no bridge credential. `ADMIN_TOKEN` still exists on the Worker, but only
for `/-/purge`, `pnpm warm`, and manual operations.

## How it works

Publishing is split across two workflows, because GitHub denies fork
`pull_request` runs both secrets and `id-token: write`. A fork PR cannot
authenticate to the bridge from the job that builds it, no matter how the
credential is delivered.

**Build leg** (`publish-preview.yml`, on `pull_request`, label `preview-build`).
Builds the PR and runs the bridge action in `mode: pack`, which packs each
locally built package directory with `pnpm pack` and stops. No network, no
credentials. The packed tarballs upload as the `bridge-packages` artifact. This
runs for forks.

**Trusted leg** (`publish-preview-register.yml`, on `workflow_run`). Runs the
workflow file from the default branch in base-repo context, so it can mint an
OIDC token whatever repository the PR came from. It downloads the artifact and
runs the action in `mode: upload`, which validates every archive, rewrites and
re-packs each one under the synthetic commit version, `PUT`s the tarball, and
`POST`s that package's metadata (`/-/publish`) so stored bytes and served
metadata never diverge for longer than one upload. A final `POST /-/register`
flips the whole version visible atomically, so a run cancelled mid-way leaves
only invisible artifacts.

The trusted leg treats the artifact as hostile, because it was produced by a job
that ran the PR's code. The published version comes from
`workflow_run.head_sha`, every package name is read back out of a validated
archive, and the bytes published are ones the trusted leg rebuilt. Nothing in
the artifact selects what gets published.

The Worker then only serves bytes from R2, with `dist.integrity` matching the
exact bytes served. pkg.pr.new is not involved anywhere.

## The label is not the security boundary

`preview-build` is the consent step, and only maintainers can apply it. But on
`pull_request` events GitHub runs the workflow file from the merge ref, so a PR
author can edit the build leg and delete its own label check, or add a workflow
with a matching `name:` to trigger the trusted leg (`workflow_run` matches on
workflow name).

The `authorize` job is what makes the label mean anything. It re-resolves the PR
from `workflow_run.head_sha` through the API, requires it open against this
repository and currently labeled, and fails closed on a missing PR, a missing
label, or an API error. Do not remove it, and do not let the publish job run
without `needs: authorize`.

## Setup

### 1. Configure the bridge

Four vars on the Worker (vars, not secrets: they hold public identifiers, and
the verification key is GitHub's public JWKS).

```bash
OIDC_AUDIENCE=https://registry-bridge.viteplus.dev
OIDC_TRUSTED_WORKFLOWS=voidzero-dev/vite-plus/.github/workflows/publish-preview-register.yml@refs/heads/main
OIDC_TRUSTED_REPOSITORY_ID=943901988
OIDC_TRUSTED_OWNER_ID=149750581
```

All four are required together; a partial configuration is rejected at request
time rather than silently disabling OIDC. Read the ids back with:

```bash
gh api repos/voidzero-dev/vite-plus --jq '{repo: .id, owner: .owner.id}'
```

`OIDC_AUDIENCE` is set per environment and never derived from
`PUBLIC_BASE_URL`. Staging's `PUBLIC_BASE_URL` points at production, so deriving
it would make a staging-minted token valid against production.

The numeric ids matter because `OIDC_TRUSTED_WORKFLOWS` embeds a repository
*name*, and names can be renamed, transferred, or released and reclaimed by
someone else. A rename keeps the same `repository_id` but changes
`workflow_ref`, so publishes fail until the allowlist is updated. That is the
correct direction to fail, but it will look like an outage to whoever hits it.

### 2. Build leg

In the job that assembles the build artifacts, after `pnpm install`, the
artifact downloads, and `publish-native-addons.ts --mode pkg-pr-new` (which
prepares `packages/cli/npm/*` and `packages/cli/cli-npm/*` on disk):

```yaml
- uses: voidzero-dev/pkg-pr-registry-bridge@<sha>
  with:
    mode: pack
    sha: ${{ github.event.pull_request.head.sha }}
    output-dir: bridge-packages
    # packages defaults to the vite-plus layout: packages/cli, packages/core,
    # packages/prompts, packages/cli/npm/*, packages/cli/cli-npm/*

- uses: actions/upload-artifact@<sha>
  with:
    name: bridge-packages
    path: bridge-packages
    if-no-files-found: error
    retention-days: 1
```

The job needs `permissions: contents: read` and nothing else. The runner needs
pnpm on `PATH` (pnpm/action-setup) and the workspace installed (`pnpm install`),
or `pnpm pack` cannot resolve `workspace:` specs. A package whose workspace dep
is missing from the batch fails the run here, before anything is packed, rather
than publishing a version with a dangling dep.

> Use `github.event.pull_request.head.sha`, not `github.sha`: on `pull_request`
> events `github.sha` is the ephemeral **merge** commit, whereas the checkout
> being packed is the PR **head** commit.

### 3. Trusted leg

```yaml
on:
  workflow_run:
    workflows: ['Publish preview build']
    types: [completed]

permissions: {}

concurrency:
  group: register-preview-${{ github.event.workflow_run.head_sha }}
  # Cancelling a publish part-way is what left the bridge with a
  # packument/tarball mismatch on 2026-07-02.
  cancel-in-progress: false

jobs:
  authorize:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.path == '.github/workflows/publish-preview.yml'
    permissions:
      contents: read
      pull-requests: read
    # Resolves the PR from head_sha, requires it open and labeled, fails closed.
    # Outputs pr, pr-url, is-fork.

  publish:
    needs: authorize
    permissions:
      id-token: write # mint the bridge OIDC token
      actions: read # download the triggering run's artifact
      contents: read
    steps:
      - uses: actions/download-artifact@<sha>
        with:
          name: bridge-packages
          path: bridge-packages
          # Pin to the triggering run. This input DEFAULTS to the current run,
          # so without it the download silently looks in the wrong place.
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}

      - uses: voidzero-dev/pkg-pr-registry-bridge@<sha>
        with:
          mode: upload
          sha: ${{ github.event.workflow_run.head_sha }}
          input-dir: bridge-packages
          # Derived from the API in authorize, never from the artifact.
          pr-url: ${{ needs.authorize.outputs.pr-url }}
```

Two rules for anything added to this workflow:

- Scope permissions per job, never union them into one block.
- No job that installs or executes preview content may hold `id-token: write`.
  The Docker preview job installs the preview package and therefore runs its
  `postinstall`, so it must stay a separate job.

`pr-url` matters more than it looks. The bridge maps it to the `pr-<n>`
dist-tag, which `VP_PR_VERSION` resolves, so a value taken from the artifact
would let one PR change what installs for another. Derive it from the API.

### 4. Verify

After a labeled PR builds and the trusted leg runs:

```bash
curl https://registry-bridge.viteplus.dev/-/refs
```

Verify a same-repo PR first, then a fork PR, then confirm an unlabeled fork PR
does **not** publish.

Note that `workflow_run` only fires for workflow files already on the default
branch, so the trusted leg cannot be exercised from the pull request that
introduces it. The first real verification happens after merge.

## Notes

- To publish a commit by hand (same code path as the action), build a vite-plus
  checkout at that commit the way the workflow does, then run
  `PKG_PR_BRIDGE_ADMIN_TOKEN=… pnpm warm --repo <checkout> <sha>`. `warm` uses
  the action's `publish` mode and the operator token, not OIDC.
- `/-/purge` is admin-token only. An OIDC identity can add preview builds and
  nothing else.
- A long-lived PR accumulates one `commit.<sha>` ref per pushed commit, which is
  how the `pr-<n>` tag advances to the PR's head build. Purge stale ones with
  `POST /-/purge` if the packument grows too large.
- Self-hosting this bridge for another project: see
  [`self-hosting.md`](./self-hosting.md), which covers the same OIDC vars for a
  fork.
