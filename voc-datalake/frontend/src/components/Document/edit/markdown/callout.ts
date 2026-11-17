/** Callouts are stored as GFM alerts: a blockquote whose first line is `[!NOTE]`, `[!TIP]` … */
import type { Blockquote } from 'mdast'

const CALLOUT_KINDS = ['note', 'tip', 'important', 'warning', 'caution'] as const
export type CalloutKind = (typeof CALLOUT_KINDS)[number]

/** The marker at the start of the alert's first paragraph, with the line break after it. */
export const ALERT_MARKER = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\n|$)/

export const isCalloutKind = (value: unknown): value is CalloutKind =>
  typeof value === 'string' && CALLOUT_KINDS.some((kind) => kind === value)

export const alertMarker = (kind: CalloutKind): string => `[!${kind.toUpperCase()}]`

/** The alert kind of a blockquote, or null: the marker must be the first paragraph's first line, alone. */
export function calloutKindOf(quote: Blockquote): CalloutKind | null {
  const first = quote.children[0]
  if (first?.type !== 'paragraph') return null
  const lead = first.children[0]
  if (lead?.type !== 'text') return null
  const match = ALERT_MARKER.exec(lead.value)
  if (!match) return null
  // `[!NOTE]` with no line break after it must be the whole paragraph (a hard break or a mark would follow it).
  if (!match[0].endsWith('\n') && (lead.value !== match[0] || first.children.length > 1)) return null
  const kind = match[1]?.toLowerCase()
  return isCalloutKind(kind) ? kind : null
}
