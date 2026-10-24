const confidenceClasses: Record<string, string> = {
  high: 'bg-ok-subtle text-ok',
  medium: 'bg-warn-subtle text-warn',
}

export function getConfidenceClass(confidence: string | undefined): string {
  return confidenceClasses[confidence ?? ''] ?? 'bg-bg-hover text-text'
}

/** Values a generated persona uses for "nothing here" — never printed to a person. */
const EMPTY_WORDS = new Set(['undefined', 'null', 'none', 'n/a'])

/**
 * A persona attribute as text a person can read, or null when it is empty:
 * missing, null, blank, a non-text value, or a stand-in such as "undefined".
 * Numbers read as written (an age, a count).
 */
export function shownText(value: unknown): string | null {
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed === '' || EMPTY_WORDS.has(trimmed.toLowerCase()) ? null : trimmed
}

/** A persona list without its empty entries (see `shownText`); anything not a list is empty. */
export function shownList(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return items.map(shownText).filter((item): item is string => item !== null)
}
