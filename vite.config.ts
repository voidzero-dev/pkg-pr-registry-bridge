import { defineConfig, lazyPlugins } from 'vite-plus'
import { voidPlugin } from 'void'

// This is a server-only Void app (API routes under `routes/`, no client bundle).
// `voidPlugin()` infers the Cloudflare bindings, loads `.env*`, and produces the
// deployable Worker for `void deploy`.
export default defineConfig({
  staged: {
    '*': 'vp check --fix',
  },
  fmt: {
    singleQuote: true,
    semi: false,
  },
  lint: {
    jsPlugins: [{ name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' }],
    rules: { 'vite-plus/prefer-vite-plus-imports': 'error' },
    options: { typeAware: true, typeCheck: true },
  },
  plugins: lazyPlugins(() => [voidPlugin()]),
})
