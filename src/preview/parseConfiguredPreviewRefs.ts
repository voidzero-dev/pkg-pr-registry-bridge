/**
 * Parses the configured preview refs (from `VITE_PLUS_PREVIEW_REFS` or the
 * runtime R2 refs index) that should be injected into packuments.
 *
 * Only immutable commit refs are supported:
 *   commit.<sha>
 *
 * PR-number refs (`pr.<n>`) are rejected: a PR ref is mutable, so its metadata
 * would be overwritten as the PR advances.
 */
import { commitVersion } from './parsePreviewVersion'

/** A ref as produced by parsing alone, with no runtime state. */
export type ParsedPreviewRef = {
  type: 'commit'
  ref: string
  version: string
}

/** A parsed ref enriched by getConfiguredRefs with runtime refs-index state. */
export type ConfiguredPreviewRef = ParsedPreviewRef & {
  publishedAt?: string
  prUrl?: string
  /** PR number projected from prUrl, when published from a PR. */
  prNumber?: string
  expiresAt?: number
}

/** Extract the PR number from a GitHub pull-request url, or undefined. */
export function prNumberFromUrl(url: string | undefined): string | undefined {
  const m = url?.match(/\/pull\/(\d+)/)
  return m ? m[1] : undefined
}

/** Parse one trimmed ref token, or return null if it is not a commit ref. */
export function parseSingleRef(value: string): ParsedPreviewRef | null {
  const commit = value.match(/^commit\.([0-9a-f]{7,40})$/i)
  if (!commit) return null
  return {
    type: 'commit',
    ref: commit[1],
    version: commitVersion(commit[1]),
  }
}

function splitRefs(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Strict parser: throws on an invalid or non-commit ref. */
export function parseConfiguredPreviewRefs(
  input: string | undefined,
): ParsedPreviewRef[] {
  return splitRefs(input).map((value) => {
    const ref = parseSingleRef(value)
    if (!ref) {
      throw new Error(
        `Invalid preview ref (only commit.<sha> is supported): ${value}`,
      )
    }
    return ref
  })
}

/** Lenient variant: drops invalid refs instead of throwing. */
export function parseConfiguredPreviewRefsSafe(
  input: string | undefined,
): ParsedPreviewRef[] {
  // Skip invalid config entries rather than failing the whole packument.
  return splitRefs(input)
    .map(parseSingleRef)
    .filter((r): r is ParsedPreviewRef => r !== null)
}
