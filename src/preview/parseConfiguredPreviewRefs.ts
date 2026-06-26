/**
 * Parses the configured preview refs (from `VITE_PLUS_PREVIEW_REFS`) that
 * should be injected into packuments.
 *
 * Supported syntax:
 *   pr.<number>
 *   commit.<sha>
 */
export type ConfiguredPreviewRef =
  | { type: 'pr'; ref: string; version: string; tag: string }
  | { type: 'commit'; ref: string; version: string; tag: string }

/** Strict parser: throws on an invalid ref. */
export function parseConfiguredPreviewRefs(
  input: string | undefined,
): ConfiguredPreviewRef[] {
  if (!input) return []
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((value) => {
      const pr = value.match(/^pr\.(\d+)$/)
      if (pr) {
        return {
          type: 'pr' as const,
          ref: pr[1],
          version: `0.0.0-pr.${pr[1]}`,
          tag: `pr-${pr[1]}`,
        }
      }

      const commit = value.match(/^commit\.([0-9a-f]{7,40})$/i)
      if (commit) {
        return {
          type: 'commit' as const,
          ref: commit[1],
          version: `0.0.0-commit.${commit[1]}`,
          tag: `commit-${commit[1]}`,
        }
      }

      throw new Error(`Invalid preview ref: ${value}`)
    })
}

/** Lenient variant: drops invalid refs instead of throwing. */
export function parseConfiguredPreviewRefsSafe(
  input: string | undefined,
): ConfiguredPreviewRef[] {
  if (!input) return []
  const out: ConfiguredPreviewRef[] = []
  for (const value of input.split(',').map((s) => s.trim()).filter(Boolean)) {
    try {
      out.push(...parseConfiguredPreviewRefs(value))
    } catch {
      // Skip invalid config entries rather than failing the whole packument.
    }
  }
  return out
}
