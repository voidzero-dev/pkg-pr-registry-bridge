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
export type ConfiguredPreviewRef = {
  type: 'commit'
  ref: string
  version: string
  tag: string
}

/** Parse one trimmed ref token, or return null if it is not a commit ref. */
function parseSingleRef(value: string): ConfiguredPreviewRef | null {
  const commit = value.match(/^commit\.([0-9a-f]{7,40})$/i)
  if (!commit) return null
  return {
    type: 'commit',
    ref: commit[1],
    version: `0.0.0-commit.${commit[1]}`,
    tag: `commit-${commit[1]}`,
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
): ConfiguredPreviewRef[] {
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
): ConfiguredPreviewRef[] {
  // Skip invalid config entries rather than failing the whole packument.
  return splitRefs(input)
    .map(parseSingleRef)
    .filter((r): r is ConfiguredPreviewRef => r !== null)
}
