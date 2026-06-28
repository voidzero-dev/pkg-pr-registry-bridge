import { forward } from './_forward'

// Catch-all: `[...path]` compiles to Hono `/:path{.+}` and sorts after any
// specific route file, so introducing focused routes later would take
// precedence automatically. Every method is forwarded so the app's
// `app.all('*')` npm fallback keeps working for non-GET requests.
export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
export const OPTIONS = forward
// No HEAD export: Hono has no `app.head` shorthand and answers HEAD via the GET
// handler automatically, at both this layer and the forwarded app.
