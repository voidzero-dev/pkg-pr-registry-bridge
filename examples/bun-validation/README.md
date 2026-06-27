# bun-validation

Manual end-to-end check of the deployed registry bridge. Installs a pkg.pr.new
preview build of Vite+ through the bridge using normal npm alias/override
semantics.

This example pins a **commit** build (`0.0.0-commit.<sha>`), which is immutable
and reproducible. (PR-number versions are not supported: a PR ref is mutable, so
its generated metadata/tarball could be overwritten as the PR advances.)

The bridge is configured as the default registry in `bunfig.toml`, and the
`vite` alias override resolves to `@voidzero-dev/vite-plus-core` at the
synthetic preview version.

## Run

```bash
cd examples/bun-validation
rm -rf node_modules bun.lock
bun install
```

## Expected

```bash
node -p "require('./node_modules/vite/package.json').name"            # @voidzero-dev/vite-plus-core
node -p "require('./node_modules/vite/package.json').version"         # 0.0.0-commit.6acea1aa818e96365b5811d47360367ba18a3a05
node -p "require('./node_modules/vite-plus/package.json').name"       # vite-plus
node -p "require('./node_modules/vite-plus/package.json').version"    # 0.0.0-commit.6acea1aa818e96365b5811d47360367ba18a3a05
node -p "require('./node_modules/@voidzero-dev/vite-plus-core/package.json').version"  # 0.0.0-commit.6acea1aa818e96365b5811d47360367ba18a3a05

bunx vp --version
```

To target a different preview build, change the `0.0.0-commit.<sha>` version in
`package.json`, and make sure that ref is exposed by the bridge via
`VITE_PLUS_PREVIEW_REFS`.
