import { forward } from './_forward'

// Single unnamed catch-all: `[...]` compiles to the Hono pattern `*`, which
// matches every path including the root `/`, so no separate root route is
// needed. Every method is forwarded so the app's `app.all('*')` npm fallback
// keeps working for non-GET requests. No HEAD export: Hono has no `app.head`
// shorthand and answers HEAD via the GET handler.
export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
export const OPTIONS = forward
