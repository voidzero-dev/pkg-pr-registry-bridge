// Shared helpers for the deploy-time scripts (warm.mjs, e2e-bun.mjs).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Read PUBLIC_BASE_URL and VITE_PLUS_PREVIEW_REFS from wrangler.toml. */
export function readWrangler() {
  const toml = fs.readFileSync(path.join(root, 'wrangler.toml'), 'utf8')
  const grab = (key) =>
    (toml.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`)) || [])[1] ?? ''
  return {
    baseUrl: grab('PUBLIC_BASE_URL'),
    refs: grab('VITE_PLUS_PREVIEW_REFS'),
  }
}

/** Map a configured ref (`commit.<sha>`) to its synthetic version, or null. */
export function refToVersion(ref) {
  const commit = ref.match(/^commit\.([0-9a-f]{7,40})$/i)
  return commit ? `0.0.0-commit.${commit[1]}` : null
}
