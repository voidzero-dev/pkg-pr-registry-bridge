import { forward } from './_forward'

// Root path `/`. The `[...path]` catch-all compiles to `/:path{.+}`, which does
// not match the empty root segment, so the root needs its own entry. Forwards
// to the same Hono app (which redirects `/` to npm, preserving prior behavior).
export const GET = forward
export const POST = forward
export const PUT = forward
export const PATCH = forward
export const DELETE = forward
export const OPTIONS = forward
// No HEAD export: Hono answers HEAD via the GET handler (see routes/[...path].ts).
