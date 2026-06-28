import { defineConfig } from 'vite'
import { voidPlugin } from 'void'

// This is a server-only Void app (API routes under `routes/`, no client bundle).
// `voidPlugin()` infers the Cloudflare bindings, loads `.env*`, and produces the
// deployable Worker for `void deploy`.
export default defineConfig({
  plugins: [voidPlugin()],
})
