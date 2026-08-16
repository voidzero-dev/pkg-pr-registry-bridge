// Shared helpers for the deploy-time scripts (warm.mjs, e2e-bun.mjs).
// Reads the bridge origin from the committed `.env` files (Void's source of
// truth for worker vars), with `.env.production` overriding `.env`. Override at
// runtime with BRIDGE_URL. Preview refs are no longer static config; they are
// registered at runtime (CI / admin endpoints), so the scripts discover them
// from the live bridge instead.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function parseEnvFile(file) {
  const out = {}
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return out
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const eq = t.indexOf('=')
    if (eq === -1) continue
    const key = t.slice(0, eq).trim()
    let val = t.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

/** Read PUBLIC_BASE_URL from `.env` + `.env.production`. */
export function readConfig() {
  const merged = {
    ...parseEnvFile(path.join(root, '.env')),
    ...parseEnvFile(path.join(root, '.env.production')),
  }
  return {
    baseUrl: merged.PUBLIC_BASE_URL || '',
  }
}

/** Map a configured ref (`commit.<sha>`) to its synthetic version, or null. */
export function refToVersion(ref) {
  const commit = ref.match(/^commit\.([0-9a-f]{7,40})$/i)
  return commit ? `0.0.0-commit.${commit[1]}` : null
}

/** Normalize a `<sha>` or `commit.<sha>` token to a bare lowercase sha, or null. */
export function normalizeSha(input) {
  const m = input.match(/^(?:commit\.)?([0-9a-f]{7,40})$/i)
  return m ? m[1].toLowerCase() : null
}
