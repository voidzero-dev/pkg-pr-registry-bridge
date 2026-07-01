/** Split a comma-separated string into trimmed, non-empty tokens. */
export function splitCsv(input: string | undefined): string[] {
  if (!input) return []
  return input
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
