# Auto-register refs via the pkg.pr.new webhook

Bridge: `https://pkg-pr-registry-bridge.render.vip`
Repo:   `voidzero-dev/vite-plus` (owner/repo are fixed in the Worker)

> This doc uses placeholders for secrets. Keep the real `ADMIN_TOKEN` and
> `GITHUB_WEBHOOK_SECRET` in a password manager, not in the repo.

## How it works

pkg.pr.new publishes a preview build in CI, and the `pkg-pr-new[bot]` posts/edits
a comment on the PR with the install URLs. A GitHub repo webhook delivers that
`issue_comment` event to the bridge's `/-/webhook`. The bridge verifies the HMAC
signature, then registers every commit sha in the
comment (`commit.<sha>`) into KV. Those versions then appear in the packument
with no redeploy, so consumers can install them immediately.

## Setup

### 1. Worker secret

```bash
printf '%s' '<YOUR_WEBHOOK_SECRET>' | wrangler secret put GITHUB_WEBHOOK_SECRET
```

### 2. Add the GitHub webhook

In `voidzero-dev/vite-plus` -> Settings -> Webhooks -> Add webhook (needs repo
admin):

- Payload URL:  `https://pkg-pr-registry-bridge.render.vip/-/webhook`
- Content type: `application/json`
- Secret:       `<YOUR_WEBHOOK_SECRET>` (same value as above)
- SSL verification: enabled
- Events:       "Let me select individual events" -> check only **Issue comments**
- Active:       yes

GitHub sends a `ping` on creation; the bridge replies `{"ok":true}` (a green
delivery). Subsequent pkg.pr.new bot comments auto-register their refs.

Or via the API:

```bash
gh api -X POST repos/voidzero-dev/vite-plus/hooks \
  -f name=web -F active=true -f 'events[]=issue_comment' \
  -f config[url]=https://pkg-pr-registry-bridge.render.vip/-/webhook \
  -f config[content_type]=json \
  -f config[secret]='<YOUR_WEBHOOK_SECRET>'
```

### 3. Verify

After a PR build publishes (the bot comments), check it registered:

```bash
curl https://pkg-pr-registry-bridge.render.vip/-/refs
```

## Alternative: a CI step instead of a webhook

If you control the publish workflow, call the admin endpoint right after
`pkg-pr-new publish` (store the admin token as an Actions secret):

```yaml
- name: Register pkg.pr.new ref with the registry bridge
  run: |
    curl -fsS -X POST \
      -H "authorization: Bearer ${{ secrets.PKG_PR_BRIDGE_ADMIN_TOKEN }}" \
      -H 'content-type: application/json' \
      -d "{\"ref\":\"commit.${{ github.event.pull_request.head.sha }}\"}" \
      https://pkg-pr-registry-bridge.render.vip/-/refs
```

> Use `github.event.pull_request.head.sha`, not `github.sha`. pkg.pr.new
> publishes under the PR **head** commit, whereas on `pull_request` events
> `github.sha` is the ephemeral **merge** commit; registering that would point
> at a SHA pkg.pr.new never built. On `push` events (no merge commit),
> `github.sha` is the head commit and is correct.

## Notes

- A long-lived PR accumulates one `commit.<sha>` ref per pushed commit. Purge
  stale ones with `POST /-/purge` if the packument grows too large.
- Enable strict ref validation by also setting `GITHUB_TOKEN` (read access to the
  repo): `POST /-/refs` then rejects refs that do not exist in the repo.
