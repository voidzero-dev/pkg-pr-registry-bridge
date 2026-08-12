# RFC 0002: Zero-trust publishing via GitHub Actions OIDC

- Status: Proposed
- Author: fengmk2
- Created: 2026-08-06
- Depends on: RFC 0001 (the bridge, its publish action, and the CI publish flow)

## 1. Summary

Replace the shared `PKG_PR_BRIDGE_ADMIN_TOKEN` secret on the publish path with
GitHub Actions OIDC tokens that the Worker verifies against GitHub's public
keys. Split the consumer workflow into an build workflow (`pull_request`,
runs for fork PRs, holds no credentials) and a trusted publishing workflow
(`workflow_run`, runs in base-repo context, mints a short-lived OIDC token).
After this change a fork PR labeled `preview-build` publishes a preview build
through the same path as a same-repo PR, and the consumer repo stores no
bridge secret at all.

npm and PyPI ship the same model as "trusted publishing": the registry trusts
a signed, claims-scoped identity token from the CI provider instead of a
stored credential.

Section 8 carries seven numbered security requirements (SR-1 through SR-7).
They are not optional hardening; two of them close paths that would let an
unlabeled fork PR, or an attacker with no repository involvement at all,
publish to production. Read that section before implementing any of this.

## 2. Motivation

The publish path (`PUT /-/tarball/*`, `POST /-/publish`, `POST /-/register`)
requires `Authorization: Bearer <ADMIN_TOKEN>` (`src/security/auth.ts`). The
consumer workflow passes it from a repo secret:

```yaml
admin-token: ${{ secrets.PKG_PR_BRIDGE_ADMIN_TOKEN }}
```

GitHub withholds secrets from `pull_request` runs triggered by forks, so
vite-plus's `publish-preview.yml` gates the bridge step on
`github.event.pull_request.head.repo.full_name == github.repository` and
skips it for external contributors. The Rust build, artifact prep, and pack
steps all run fine for forks; only the upload cannot authenticate. Reviewers
therefore cannot install or smoke-test an external contributor's PR through
the bridge, the Docker preview image never builds, and the sticky PR comment
never posts.

The shared secret has second-order costs too: one value grants every write
endpoint including `/-/purge`, it never expires, and rotating it means
touching the Worker secret and every consumer repo in lockstep.

## 3. Constraints

Two GitHub platform rules shape the design:

1. **Fork `pull_request` runs cannot mint OIDC tokens.** They receive a
   read-only `GITHUB_TOKEN`, no secrets, and no `id-token: write`. Swapping
   the admin token for OIDC inside the existing workflow would still skip
   forks.
2. **`workflow_run` workflows run in base-repo context.** They execute the
   workflow file from the default branch, regardless of what the triggering
   PR contains, and they may hold `id-token: write`. This is GitHub's
   sanctioned pattern for "untrusted build, trusted follow-up".
3. **The triggering run's workflow file is PR-controlled, and
   `workflow_run` matches on workflow name.** On `pull_request` events
   GitHub runs the file from the merge ref, so a fork PR can edit the build
   workflow (including its label gate) or add another file with a matching
   `name:`. The listening workflow is trusted; what caused it to fire is
   not. Everything the publishing workflow needs about authorization it must read
   from the API, not from the triggering run (SR-1).

`pull_request_target` also gets credentials but is rejected: it would build
untrusted PR code in a job able to mint publish tokens, and any build script
(a `postinstall`, a patched config) could exfiltrate them. The design below
keeps untrusted code execution and credentials in separate workflows at all
times.

## 4. Design overview

```
fork or same-repo PR, label `preview-build` (maintainer-applied gate)
        │
        ▼
[A] publish-preview.yml            on: pull_request (types: labeled)
    permissions: contents: read    ── runs PR code, holds NOTHING ──
    build Rust + JS, prepare package dirs
    bridge action `mode: pack`  →  tarballs + manifest.json
    upload as workflow artifact `bridge-packages`
        │  completes
        ▼
[B] publish-preview-register.yml   on: workflow_run (workflows: [A])
    permissions: {} at top level   ── runs MAIN's workflow file,  ──
                                   ── never executes PR code      ──
    job `authorize`  (pull-requests: read)          ← SR-1, fail-closed
      resolve PR from workflow_run.head_sha via API
      require: PR open on this repo + label `preview-build`
      emit trusted pr number + pr url
    job `publish`    (id-token: write, actions: read)
      download artifact from run id ${{ github.event.workflow_run.id }}
      bridge action `mode: upload`:
        re-derive version from workflow_run.head_sha
        extract package.json from each tarball, validate, re-hash
        mint OIDC token (audience = OIDC_AUDIENCE)
        PUT tarballs, POST /-/publish, POST /-/register
    job `comment`    (pull-requests: write, issues: write)   ← no id-token
    job `docker`     (packages: write)                       ← no id-token
        │
        ▼
[C] Worker: verify JWT (RS256 pinned) via GitHub JWKS,
    check aud + workflow_ref allowlist + prUrl binding,
    then serve as today
```

The maintainer-applied `preview-build` label stays as the human approval
step, playing the role GitHub's "approve and run" button plays for
first-time contributors. It is only a boundary because the `authorize` job
re-checks it against repository state; the copy of that check in [A] runs in
a file the PR author can edit. Section 8.1 covers what the label does and
does not bound.

## 5. Bridge changes

### 5.1 OIDC verification (`src/security/oidc.ts`, new)

`requirePublisher()` accepts either the existing admin bearer token or a
GitHub OIDC JWT on the three publish endpoints. A token containing two dots
is treated as a JWT; anything else falls through to the timing-safe admin
compare. Verification steps:

1. Decode the header and look up `kid` in GitHub's JWKS
   (`https://token.actions.githubusercontent.com/.well-known/jwks`).
2. Verify the signature with WebCrypto (`crypto.subtle.verify`). No JWT
   library needed; the Worker already avoids heavy deps.
3. Check `iss` equals `https://token.actions.githubusercontent.com`.
4. Check `exp` / `nbf` / `iat` with a small clock skew (60s). GitHub issues
   these tokens with a lifetime of minutes.
5. Check `aud` equals `OIDC_AUDIENCE`.
6. Check `repository_id` and `repository_owner_id` equal
   `OIDC_TRUSTED_REPOSITORY_ID` / `OIDC_TRUSTED_OWNER_ID`.
7. Check `workflow_ref` is listed in `OIDC_TRUSTED_WORKFLOWS`.

Because this is a hand-rolled verifier rather than a library, four details
are mandatory (see [SR-3](#sr-3-verifier-hardening)): the algorithm is
pinned to RS256 in code rather than read from the token header, so `alg:
none` and any HMAC variant are rejected before a key is loaded; the key is
selected by `kid` from the fetched JWKS and never from anything else in the
token; `aud` is compared as an exact string, including the case where it
arrives as a single-element array; and the unknown-`kid` refetch is rate
limited so a stream of bogus `kid` values cannot drive unbounded outbound
fetches. Getting the first of these wrong lets anyone on the internet
publish with a self-signed token, no workflow and no repository involved.
SR-3 also bounds the parsing itself, since the token is entirely
attacker-supplied.

Steps 6 and 7 together form the identity check. `workflow_ref` is the
specific part: for a `workflow_run` workflow it names the trusted file at
the default branch, e.g.
`voidzero-dev/vite-plus/.github/workflows/publish-preview-register.yml@refs/heads/main`.
GitHub signs it; no workflow can spoof it. Pinning it means the untrusted
build workflow, a PR-modified copy of the publish workflow, or any other
workflow in the repo cannot obtain a token the bridge accepts, even with
`id-token: write` granted.

`workflow_ref` alone is not sufficient, because it embeds a repository
*name*, and names are mutable and reusable. If `voidzero-dev/vite-plus` were
renamed, transferred, or deleted, a `workflow_ref` string match could later
be satisfied by a repository the org does not control. `repository_id` is
immutable and survives renames, so it anchors the check to the actual
repository (see [SR-7](#sr-7-immutable-repository-identity)).

`repository_owner_id` is checked as well, because `repository_id` alone does
not cover a transfer *out* of the org: the id follows the repository to its
new owner. Pinning both means a transferred repository fails closed rather
than continuing to publish.

The operational consequence is worth stating: a legitimate rename keeps the
same `repository_id` but changes `workflow_ref`, so `OIDC_TRUSTED_WORKFLOWS`
needs updating and publishes fail until it is. That is the correct
direction to fail.

If the publish step later moves into a reusable workflow, `workflow_ref`
starts naming the calling workflow and `job_workflow_ref` names the reusable
file. The allowlist semantics shift silently at that point, so the check
carries a comment saying so.

JWKS caching goes through the existing `KV` binding (the Void runtime bans
`caches.default`) with a TTL of a few hours.

### 5.2 Configuration (`src/config.ts`)

```ts
/**
 * Audience required in OIDC tokens. No default: each environment sets its
 * own, and an unset value disables the OIDC path rather than falling back
 * to another binding (see 8.2, SR-4).
 */
OIDC_AUDIENCE?: string
/**
 * Comma-separated allowlist of exact `workflow_ref` values permitted to
 * publish, e.g.
 * `voidzero-dev/vite-plus/.github/workflows/publish-preview-register.yml@refs/heads/main`.
 * Empty/unset disables the OIDC path (admin token only).
 */
OIDC_TRUSTED_WORKFLOWS?: string
/**
 * Immutable GitHub numeric ids the token must carry, anchoring the trust to
 * the actual repository rather than to a mutable name (see 8.2, SR-7).
 * Read them once with:
 *   gh api repos/voidzero-dev/vite-plus --jq '{repo: .id, owner: .owner.id}'
 * Both required whenever OIDC_TRUSTED_WORKFLOWS is set.
 */
OIDC_TRUSTED_REPOSITORY_ID?: string
OIDC_TRUSTED_OWNER_ID?: string
```

Plain vars, not secrets: the allowlist holds public identifiers, and the
verification key is GitHub's public JWKS. This is the zero-trust property:
after rollout the publish path stores no shared secret on either side.

`OIDC_AUDIENCE` deliberately has no fallback to `PUBLIC_BASE_URL`. Staging's
`PUBLIC_BASE_URL` already points at production, so a fallback would give
both environments the same audience and make a token minted through
staging's looser allowlist replayable against production.

### 5.3 Endpoint scoping

| Endpoint | Today | After |
| --- | --- | --- |
| `PUT /-/tarball/*` | admin token | admin token or OIDC |
| `POST /-/publish` | admin token | admin token or OIDC |
| `POST /-/register` | admin token | admin token or OIDC |
| `POST /-/purge` | admin token | admin token only |

An OIDC identity can add preview builds and nothing else. Deletion and any
future admin surface stay on the operator token, which remains for
`scripts/warm.mjs`, manual ops, and the staging smoke test.

### 5.4 Binding the PR number to the publishing commit

`registerRef` stores the caller-supplied `prUrl`, `getConfiguredRefs.ts:78`
derives `prNumber` from it, and `latestVersionByPr` awards the `pr-<n>`
dist-tag to whichever ref carries the newest `publishedAt`. Any publisher can
therefore point `pr-<n>` at a commit belonging to a different PR, and since
`VP_PR_VERSION` resolves by PR number in both `install.sh` and the Docker
build-arg, the hijacked tag changes what a reviewer following another PR's
comment installs.

Three changes close it (see [SR-2](#sr-2-pr-number-binding)):

- The publishing workflow resolves the PR from the triggering run's head
  repository and branch, then constructs `prUrl` from it. It is never read
  from the artifact. This is the authoritative binding; the two bridge-side
  checks below are containment.
- `/-/register` rejects a `prUrl` outside
  `https://github.com/<repository claim>/pull/`, so a CI identity cannot name
  a pull request in another repository.
- `/-/register` refuses to re-point an already-registered ref at a
  *different* `prUrl`, unless the caller holds the admin token. A commit
  belongs to one pull request, so a rewrite can only be an attempt to drag
  another PR's tag onto this commit.

An earlier draft of this section also proposed rejecting a `prUrl` whose PR
number was already bound to a ref under a different commit. Implementing it
showed that to be wrong: a PR accumulates one `commit.<sha>` ref per pushed
commit, all sharing a `prUrl`, and that is exactly how `latestVersionByPr`
advances `pr-<n>` to the PR's head build. The rule would have broken every
multi-commit PR. The per-ref immutability above is the version that holds.

The bridge cannot do better on its own: verifying that a commit really
belongs to a PR needs a GitHub API call, which would put an API dependency
and its rate limits on the publish path. That check belongs in the trusted
workflow, which is already talking to the API for SR-1.

This gap predates the RFC: the admin-token path has it today, bounded by the
fact that publishing currently requires repository write access. Handing the
publish capability to labeled fork PRs is what makes it worth fixing, so the
Worker-side check ships in the bridge PR (step 1) rather than waiting for the
consumer rollout.

The existing `WORKSPACE_PACKAGES` allowlist continues to bound which package
names any publisher can touch.

## 6. Publish action changes

The action gains a `mode` input with three values:

- **`publish`** (default): today's behavior, pack and upload in one job,
  authenticated by `admin-token`. Kept for `scripts/warm.mjs` and manual
  runs.
- **`pack`**: run the local half only. `pnpm pack` each directory, rewrite
  to the synthetic version, re-pack, hash, and write the tarballs plus a
  `manifest.json` (ref, version, file list) to `output-dir`. No network, no
  credentials. Runs in the build workflow.
- **`upload`**: run the remote half only, from `input-dir`. Runs in the
  publishing workflow.

`admin-token` becomes optional. In `upload` mode without it, the action
mints an OIDC token itself via the runner's
`ACTIONS_ID_TOKEN_REQUEST_URL`/`ACTIONS_ID_TOKEN_REQUEST_TOKEN` environment
(one `fetch` with `audience=<bridge origin>`; no `@actions/core` dependency),
minted per attempt so retries never send an expired token.

`upload` mode treats the artifact as untrusted bytes:

- It derives the expected version from its own `sha` input (wired to
  `github.event.workflow_run.head_sha`, a trusted payload field), never from
  `manifest.json`, which is advisory only.
- It validates each archive against the [SR-6](#sr-6-canonical-archive)
  policy, then rebuilds it canonically and hashes its own output. The
  `packageJson`, shasum, and integrity sent to `/-/publish` all describe
  bytes this step constructed, not bytes the fork produced.
- It checks the extracted name against the workspace allowlist and the
  version against the expected version.
- It executes nothing from the artifact: no install, no scripts, pure data
  handling.

A tampered artifact can therefore only change the *contents* of the files
inside the tarball, which land under the attacking PR's own
`0.0.0-commit.<sha>` version. A preview build of a PR already carries that
PR's arbitrary code by definition; the blast radius is unchanged.

Since the publishing workflow now rebuilds anyway, `pack` mode arguably should not
rewrite and re-pack at all: it could emit raw `pnpm pack` output (the one
step that genuinely needs the workspace and its `node_modules`), leaving the
version rewrite, dependency pinning, canonical re-pack, and hashing to the
publishing workflow, which can derive the batch from the tarball names it validated.
That would put every step whose output the bridge trusts on the trusted side
of the boundary, and shrink `pack` mode to a thin wrapper. It costs the
trusted job more CPU, which is free here: the CPU constraint in RFC 0001 was
the Worker's, never CI's. Left as a refinement for the action PR rather than
settled now, since it changes the artifact contract between the two workflows.

## 7. Consumer workflow changes (vite-plus)

`publish-preview.yml` keeps its trigger (`pull_request`, `types: [labeled]`,
label `preview-build`) and its build jobs, drops the same-repo gate, and
replaces the bridge step with `mode: pack` plus an `actions/upload-artifact`
step (short retention, one day). Its `permissions` stay `contents: read`.

A new `publish-preview-register.yml` handles the publishing workflow:

```yaml
on:
  workflow_run:
    workflows: ['Publish preview build']
    types: [completed]

permissions: {}

jobs:
  # Gate: re-establish authorization from repository state, because the
  # build workflow's own label check ran in a file the PR author can edit.
  authorize:
    if: >-
      github.event.workflow_run.conclusion == 'success' &&
      github.event.workflow_run.event == 'pull_request' &&
      github.event.workflow_run.path == '.github/workflows/publish-preview.yml'
    permissions:
      contents: read
      pull-requests: read
    outputs:
      pr: ${{ steps.check.outputs.pr }}
      pr-url: ${{ steps.check.outputs.pr_url }}
      is-fork: ${{ steps.check.outputs.is_fork }}
    steps:
      # Resolves the PR from head_sha, then fails the job unless that PR is
      # open against this repo AND currently carries `preview-build`.
      # Fail-closed: no PR found, no label, or an API error stops the run.
      - id: check
        uses: actions/github-script@<pinned>
        # ...

  publish:
    needs: authorize
    # Fork PRs wait on a required-reviewer environment; same-repo PRs use an
    # unprotected one and publish unattended. See the environment gate note
    # below and 8.1.
    environment: ${{ needs.authorize.outputs.is-fork == 'true' && 'preview-build-release' || 'preview-build-release-auto' }}
    permissions:
      id-token: write      # mint the bridge OIDC token
      actions: read        # download the triggering run's artifact
      contents: read
    steps:
      - uses: actions/download-artifact@<pinned>
        with:
          run-id: ${{ github.event.workflow_run.id }}
          github-token: ${{ github.token }}
          name: bridge-packages
      - uses: voidzero-dev/pkg-pr-registry-bridge@<pinned-sha>
        with:
          mode: upload
          sha: ${{ github.event.workflow_run.head_sha }}
          pr-url: ${{ needs.authorize.outputs.pr-url }}
          input-dir: bridge-packages

  # Separate job: holds pull-requests/issues write, never id-token.
  comment:
    needs: [authorize, publish]
    permissions:
      pull-requests: write
      issues: write
    # ...
```

Details that matter:

- **The `authorize` job is a security control, not a payload workaround.**
  See [SR-1](#sr-1-publishing-workflow-authorization); it is the only thing that
  makes the label a boundary. It also supplies the PR number and URL, which
  `github.event.workflow_run.pull_requests` leaves empty for fork PRs.
- `download-artifact` pins `run-id` to the triggering run. Downloading "the
  latest artifact by name" across runs is the classic artifact-poisoning
  bug.
- **Permissions are scoped per job, never unioned into one block.** No job
  that installs or executes preview content may hold `id-token: write` (see
  [SR-5](#sr-5-credential-separation)).
- The sticky-comment job, the Docker preview image, and its comment job all
  move here. They need write permissions that fork `pull_request` runs are
  denied, so today they are as fork-broken as the bridge step. The Docker
  job needs no artifact; it installs through the bridge as before.
- Concurrency groups key on `workflow_run.head_sha` so re-labels and
  re-pushes coalesce as today.
- Same-repo PRs use this same path. One publish flow to maintain, and the
  `PKG_PR_BRIDGE_ADMIN_TOKEN` secret leaves the repo.
- **The `publish` job selects its environment by PR origin.** Fork PRs run
  in `preview-build-release`, which requires a reviewer to approve the run
  before the job starts and a token exists; same-repo PRs run in
  `preview-build-release-auto`, which has no protection rules, so they
  publish unattended once labeled. Both environments must exist in repo
  settings: a workflow referencing a missing environment gets one created
  implicitly with no rules, which looks like a gate and is not one. The
  initial implementation gated every publish; vite-plus#2404 (2026-08-11)
  narrowed the gate to forks, because for a self-labeled same-repo run the
  approval confirmed nothing the label had not, and approval notifications
  proved easy to miss. After any approval wait, the job re-asserts SR-1
  (PR open, still labeled, head sha unchanged) before minting the token.

## 8. Security

### 8.1 What the label does and does not cover

The `preview-build` label is the consent step, and only people with triage
or write access can apply it. That bounds drive-by publish spam and the
resource-exhaustion cases below. It does not bound as much as it looks like
it does, for two reasons.

First, on `pull_request` events GitHub runs the workflow file from the merge
ref, so the PR's own edits to that file take effect. The build workflow's
`if: contains(github.event.pull_request.labels.*.name, 'preview-build')`
therefore runs inside a file the PR author controls, and a fork PR can
delete it, or add a second workflow file carrying the same `name:`, and
produce a successful run that `workflow_run` matches by name. Authorization
is real; enforcement in the build workflow is not. That is why SR-1 exists.

Second, the label authorizes "build a preview of this contributor's PR." It
is applied precisely so reviewers can test code nobody has audited yet, so
reading it as "a trusted person vouched for this code" inverts what
maintainers use it for. It cannot carry the weight of the bridge-side
checks (SR-2 through SR-4), which are reachable without any PR at all.

Also worth stating plainly: GitHub's default for public repositories
requires approval only for *first-time* contributors. Once someone has a
merged PR, their fork PRs run workflows automatically, so that gate does not
add much against a patient attacker.

The implementation layers one more human step on top of the label, for
forks only: the `publish` job runs in a required-reviewer environment, so a
person confirms each fork publish run after `authorize` passes and before a
token exists (section 7). That gate is the one control that stays standing
if the `authorize` logic is ever weakened. It is scoped to forks because
for a same-repo PR the label already binds consent to the exact built sha:
the build runs only on `labeled` events, and `authorize` refuses a run
whose sha the PR has moved past.

### 8.2 Security requirements

These are implementation requirements, not defense-in-depth. The design is
not safe to ship without them.

<a id="sr-1-publishing-workflow-authorization"></a>
**SR-1. The publishing workflow re-establishes authorization from repository
state.** Before publishing, resolve the PR through the API and fail unless it
is open against this repository, currently carries `preview-build`, and still
points at the commit that was built. Fail closed on a missing PR, a missing
label, or an API error. Without this, any fork PR publishes to production
without a label, because the build workflow's own check is attacker-editable
(8.1). Gating on `workflow_run.path` as well blocks the extra-workflow-file
variant but not an edit to the original, so it is a supplement, never the
control.

Resolve it by **head repository and branch**
(`GET /pulls?state=open&head=<head_owner>:<head_branch>`, both from
GitHub-signed `workflow_run` payload fields), then check the head sha
separately so the failure distinguishes "no such PR" from "the PR moved on".

An earlier draft said to resolve from `head_sha` via
`GET /repos/{repo}/commits/{head_sha}/pulls`. That endpoint returns EMPTY for
a fork PR's head commit while working correctly for a same-repo one, so it
passes every test reachable before the workflow is on the default branch and
fails for the only case this design exists for. `workflow_run.pull_requests`
is fork-blind in the same way, which is what makes the commit endpoint look
like the alternative. Anything keyed on a fork's commit is suspect; the PR
number, the run id, and the head branch are all base-repo facts and are not.

<a id="sr-2-pr-number-binding"></a>
**SR-2. The PR number is derived, never accepted.** The publishing workflow builds
`prUrl` from the API lookup in SR-1. The bridge contains it: `/-/register`
rejects a `prUrl` outside the token's `repository` claim, and refuses to
re-point an existing ref at a different `prUrl` (5.4). Otherwise a single
labeled fork PR can retarget `pr-<n>` for any other PR and change what
`VP_PR_VERSION=<n>` installs.

<a id="sr-3-verifier-hardening"></a>
**SR-3. The JWT verifier pins RS256 in code, and bounds its own parsing.**
Never read `alg` from the token header; select the key by `kid` from the
JWKS; compare `aud` exactly, array form included; rate limit the
unknown-`kid` refetch (5.1). An `alg: none` acceptance is a full
authentication bypass for anyone on the internet.

Because the token is entirely attacker-supplied and the endpoint is
internet-facing, the parse is bounded before any of that runs: a maximum
whole-token size, maximum decoded header and payload sizes, a maximum `kid`
length, exactly three segments (reject anything else rather than ignoring
extras), strict Base64URL decoding that rejects non-alphabet characters and
padding, and a type check on every claim read rather than coercion. These
are DoS protections rather than authentication properties, and they cost a
handful of lines each.

<a id="sr-4-environment-isolation"></a>
**SR-4. Each environment sets `OIDC_AUDIENCE` explicitly.** No fallback to
`PUBLIC_BASE_URL`, which staging already points at production (5.2). A
shared audience makes a staging-minted token valid against production.

<a id="sr-5-credential-separation"></a>
**SR-5. No job that installs or executes preview content holds
`id-token: write`.** Scope permissions per job (section 7). The Docker
preview job installs the fork's package and therefore runs its
`postinstall`; buildkit does not forward job environment into the build by
default, but one added `build-arg` or `run:` step would reintroduce
`ACTIONS_ID_TOKEN_REQUEST_TOKEN`.

<a id="sr-6-canonical-archive"></a>
**SR-6. The publishing workflow validates archives against a canonical policy and
republishes its own bytes.** The tar codec now reads attacker-supplied
tarballs, having only ever seen `pnpm pack` output before. Two parts:

*Reject*, before reading any content:

| Rejected | Why |
| --- | --- |
| Duplicate normalized paths | Parser differential (below) |
| More than one `package/package.json` | Same, and the highest-value target |
| `../` traversal, absolute paths, drive letters | Escape on any extractor that writes to disk |
| Entry types other than file and directory | Symlinks, hardlinks, devices, FIFOs have no place in an npm tarball |
| Entry count above a fixed cap | Zip-bomb by inode count |
| Any single file, or the decompressed total, above a cap | Gzip bomb, runner OOM |
| Entries outside the `package/` prefix | npm's own layout invariant |

Symlinks must also not be followed when enumerating `input-dir` itself.

*Then canonicalize*: rather than forwarding the fork's bytes, the trusted
workflow rebuilds the tarball with the Worker's own codec, emitting exactly one
entry per path with normalized metadata, and hashes what it emitted. The
shasum and integrity published to the bridge describe bytes the publishing workflow
constructed.

The canonical rebuild is what makes the reject list robust rather than
best-effort. Tar permits duplicate entries and extractors disagree about
which one wins, most taking the last. A validator reading the first
`package/package.json` while pnpm extracts the last would validate metadata
no consumer ever sees, which defeats the name and version checks in
section 6 without tripping any of them. Emitting a fresh archive collapses
the whole class: there is no second entry to disagree about. It also costs
little, because `buildPreviewTarball` already rewrites, re-packs and hashes
today.

<a id="sr-7-immutable-repository-identity"></a>
**SR-7. Trust is anchored on `repository_id` and `repository_owner_id`, not
only `workflow_ref`.** `workflow_ref` embeds a repository name, and names
are mutable and reusable: a rename, transfer, or deletion could later let a
repository the org does not control satisfy a string match. The numeric ids
are immutable, and pinning both means a repository transferred out of the
org fails closed rather than continuing to publish (5.1). Set both whenever
`OIDC_TRUSTED_WORKFLOWS` is set.

### 8.3 Threat model

- **Fork PR modifies workflows to publish directly.** Fork `pull_request`
  runs get no secrets and no `id-token`; SR-1 rejects the forged trigger.
- **Fork PR poisons the artifact.** The publishing workflow validates, rebuilds and
  re-hashes, and forces name and version from trusted inputs (SR-6). Damage
  stays inside that PR's own preview version, which carries the PR's code by
  design.
- **Crafted archive splits the validator from the consumer.** Duplicate
  `package/package.json` entries would let the validator approve metadata
  pnpm never extracts; the canonical rebuild in SR-6 removes the ambiguity
  rather than trying to match every extractor's precedence.
- **Another repo workflow with `id-token: write` requests a bridge-audience
  token.** The signed `workflow_ref` claim names that workflow, not the
  allowlisted one, and the bridge rejects it.
- **Repository renamed, transferred, or deleted and its name reclaimed.**
  SR-7 pins the immutable numeric ids, so a name match alone does not
  authorize a publish.
- **Self-signed or algorithm-confused token; oversized or malformed token.**
  SR-3.
- **Staging token replayed against production.** SR-4.
- **`pr-<n>` dist-tag hijack redirecting `VP_PR_VERSION`.** SR-2.
- **Preview `postinstall` steals the publish token.** SR-5.
- **Stolen OIDC token replayed.** Lifetime of minutes, audience-bound, and
  scoped to publish-only endpoints; SR-5 keeps it out of any job running
  untrusted code. Single-use `jti` tracking in KV stays available as
  hardening (open question 3).
- **Squatting foreign package names.** The `WORKSPACE_PACKAGES` allowlist is
  enforced in both the action and the Worker.
- **Drive-by publish spam, R2 growth from repeated label toggles.** The
  label bounds who can trigger a publish; a per-`repository`-claim rate limit
  bounds volume (open question 4). Refs already expire after 90 days.
- **Comment redirected to another PR.** The PR is resolved from `head_sha`
  via the API, not from artifact contents.
- **GitHub JWKS rotation.** The KV-cached JWKS is refetched on an unknown
  `kid`, subject to SR-3's rate limit.

### 8.4 Accepted risks

- A malicious PR that a maintainer labels gets its code packed and served as
  its own preview version. That is the product's purpose and the current
  behavior for same-repo PRs.
- The label becomes a publishing permission. Triage-role users, who
  previously could trigger only builds, can now put code on the production
  registry. Anyone reviewing who holds triage in `voidzero-dev/vite-plus`
  should do so with that in mind. Since vite-plus#2404 a labeled same-repo
  PR publishes unattended; only fork publishes wait for an environment
  approval.
- Fork code gets pushed to `ghcr.io/voidzero-dev/vite-plus:pr-<n>`, under the
  org namespace, and the sticky comment advertises a `curl | bash` install
  from a voidzero-branded URL. The comment must say the build came from a
  fork, so nobody reads an official-looking install line as vetted code.

  This is newly possible rather than pre-existing. Today a fork PR cannot
  push to GHCR at all: GitHub caps `GITHUB_TOKEN` at read-only for fork
  `pull_request` runs, so `docker/login-action` fails whatever `permissions:`
  declares, and the build would fail earlier anyway because `VP_PR_VERSION`
  has nothing to resolve. Moving the job into the `workflow_run` workflow
  gives it a full-permission token in base-repo context, which is the point
  of moving it and also what makes the push succeed with fork code inside.
  Keeping the Docker job on `pull_request` instead would preserve today's
  behavior at the cost of leaving fork PRs without a preview image; see open
  question 6.
- A registered `commit.<sha>` for a fork commit is reachable from the base
  repo through `refs/pull/<n>/head`, but `x-commit-key` will name a SHA that
  is not on any branch of `voidzero-dev/vite-plus`.
- Publish volume rises, so the cancelled-publish edge-cache mismatch seen on
  2026-07-02 gets more likely. Unchanged in kind, higher in frequency.

## 9. Alternatives considered

- **OIDC on `pull_request` directly.** Fails constraint 1: forks cannot mint
  tokens. Would still skip external contributors.
- **`pull_request_target` with OIDC.** Untrusted code and a token-minting
  context in one job; one `postinstall` away from credential exfiltration.
- **pkg.pr.new's model: a GitHub App plus a webhook-opened publish window.**
  Their CLI sends no credential at all. It hashes public run metadata
  (`owner`, `repo`, `GITHUB_RUN_ID`, `GITHUB_RUN_ATTEMPT`,
  `GITHUB_ACTOR_ID`) into an `sb-key` header; their App, installed on the
  base repo, receives `workflow_run` webhooks, recomputes the same hash, and
  stores a record keyed by it. The publish endpoint authorizes by checking
  that the record exists, then burns it. The window opens on
  `requested`/`in_progress` and closes on `completed`. The CLI uploads
  tarballs directly, so the server never pulls artifacts from the GitHub
  API.

  Fork PRs work because nothing token-shaped is involved: a fork's
  `pull_request` run belongs to the base repo, so `GITHUB_REPOSITORY` in the
  runner and `payload.repository` in the webhook agree, and GitHub's fork
  restrictions on secrets and `id-token` never come into play. Consumers get
  a much simpler workflow than section 7's split: `permissions: {}` and one
  CLI call, no second workflow.

  Rejected for three reasons, none of them CPU: the App needs a private key
  and a webhook secret, which reintroduces exactly the stored credential
  this RFC removes; it needs an installation and webhook endpoint to
  operate; and authorization rests on possession of a value derived from
  public data plus a time window, rather than a signature. The OIDC design
  keeps the bridge's publish path secret-free on both sides.

  Worth noting their maintainers considered and declined the reverse move.
  In [issue #535](https://github.com/stackblitz-labs/pkg.pr.new/issues/535)
  they rejected OIDC trusted publishing specifically because it would lose
  fork-PR support, which is independent confirmation of constraint 1.
  Their README also recommends gating publishes on
  `pull_request_review: [submitted]` with an approved state and a
  write-permission check, the same consent-gate shape as our `preview-build`
  label.
- **Per-repo scoped bridge tokens.** Nicer blast radius than one admin
  token, but still a stored secret, still absent from fork runs. Solves
  nothing for external contributors.
- **GitHub artifact attestations (`actions/attest-build-provenance`).**
  Attestation generation needs `id-token` too, so it inherits the same fork
  limitation; as an extra provenance layer on top of this design it remains
  open as future work.

## 10. Rollout

0. **Confirm the forgery empirically.** On a scratch repo, check whether a
   fork PR that renames a workflow to a `workflow_run`-matched name, or
   deletes the label gate, does trigger the listening workflow. SR-1 ships
   either way (one API call), but the answer decides how much the
   `workflow_run.path` check is worth and belongs in the record.
1. **Bridge PR**: `oidc.ts`, `requirePublisher()` on the three publish
   endpoints, config vars, the SR-2 `prUrl` binding, pool-workers tests with
   a locally-signed JWKS fixture. Negative tests are the point here: `alg:
   none`, an HMAC-signed token, a wrong `aud`, an unlisted `workflow_ref`, a
   correct `workflow_ref` with a mismatched `repository_id` or
   `repository_owner_id` (SR-7), an oversized and a two-segment token
   (SR-3), an expired token, and a `prUrl` bound to another commit must each
   be rejected. Extend the staging smoke: the bridge repo's staging workflow
   gains `id-token: write` and exercises the OIDC publish path end to end
   against staging (its own `workflow_ref` allowlisted there, its own
   `OIDC_AUDIENCE` per SR-4), alongside the existing admin-token smoke.
   Requires `pnpm build:action` + committed dist per the bundle-staleness
   check.
2. **Action PR**: `mode` input, the SR-6 validate-and-rebuild path, OIDC
   minting; `action.yml` marks `admin-token` optional and adds `pr-url` as a
   trusted-caller input. Fixture archives for each SR-6 rejection case,
   the duplicate `package/package.json` one especially, since it is the case
   a naive extract-first implementation passes. Decide the `pack`/`upload`
   split question raised in section 6 here.
3. **vite-plus PR**: split the workflow as in section 7, including the SR-1
   `authorize` job and SR-5 per-job permissions; add the new `workflow_ref`
   to prod's `OIDC_TRUSTED_WORKFLOWS`; verify a same-repo PR, then a fork PR,
   publish end to end. Verify the negative case too: an unlabeled fork PR
   must not publish.
4. **Cleanup**: delete `PKG_PR_BRIDGE_ADMIN_TOKEN` from vite-plus secrets.
   `ADMIN_TOKEN` stays on the Worker for purge, warm, and ops. Update
   `docs/ci-setup.md` and `docs/self-hosting.md`.

Each step deploys independently; the admin-token path keeps working
throughout, so a rollback at any step is a workflow revert. Step 1's SR-2
fix stands alone and is worth landing regardless of whether the rest ships.

## 11. Open questions

1. Should `/-/register` from an OIDC identity refresh `expiresAt` on
   republish exactly as the admin path does, or should fork-originated refs
   get a shorter TTL? Proposed: identical behavior, revisit if fork volume
   grows.
2. One `OIDC_TRUSTED_WORKFLOWS` list, or per-entry package scoping (workflow
   X may publish packages matching Y)? Proposed: single list now;
   `WORKSPACE_PACKAGES` already bounds names globally, and the bridge serves
   one repo's packages today.
3. Bind the token to the commit it may publish? Today the capability is
   scoped by audience and workflow, so a stolen token can publish anything
   that workflow could during its lifetime. The publishing workflow already knows
   `workflow_run.head_sha`, so it could request
   `audience = <OIDC_AUDIENCE>#<sha>` and the bridge could require every
   version in the request to equal `0.0.0-commit.<sha>`. Distinct from `jti`
   replay protection: replay limits reuse, this limits authority. Proposed:
   adopt. It is a few lines on each side and converts token theft from
   "publish any preview" into "republish this one commit", which also caps
   the damage from an SR-5 mistake.
4. Single-use `jti` replay protection in KV: worth the write per publish?
   Proposed: skip; SR-5 keeps the token away from untrusted code, the
   publish surface is preview-only, and question 3 bounds authority more
   cheaply.
4. Per-`repository`-claim publish rate limit: needed at launch, or deferred
   until fork volume justifies it? Proposed: defer, since the label already
   bounds trigger frequency and refs expire after 90 days.
5. Should the sticky comment render differently for fork-originated builds
   (8.4), and how loudly? Proposed: a one-line banner naming the source
   fork above the install instructions.
6. Does the Docker preview job move into the publishing workflow at all? Moving it
   is what lets fork code reach `ghcr.io/voidzero-dev/vite-plus:pr-<n>`
   (8.4); leaving it on `pull_request` keeps forks out of the org namespace
   but also leaves them without a preview image, which is part of what this
   RFC set out to fix. Proposed: move it, with the fork banner from question
   5 carried into the Docker comment as well.
