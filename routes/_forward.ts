import { defineHandler } from 'void'
import { app } from '../src/app'
import type { Env } from '../src/config'

// Shared request forwarder. Files prefixed with `_` are ignored by the router,
// so this is a plain helper, not a route. Void owns the Worker entry; the route
// files below forward every request to the existing Hono registry app
// (`src/app.ts`), which keeps its routing, npm-redirect fallback, and error
// handling. `c.env` carries both the inferred `STORAGE` R2 binding and the
// `.env` vars/secrets, matching the app's `Env` shape.
export const forward = defineHandler((c) =>
  app.fetch(c.req.raw, c.env as unknown as Env, c.executionCtx),
)
