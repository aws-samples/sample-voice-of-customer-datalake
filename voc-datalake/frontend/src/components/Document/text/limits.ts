/**
 * @fileoverview A text against its document's limits (the adapter's `limits`): which one it is past, if any. The
 * count turns danger and Save waits, with the reason beside it; the server stays the gate.
 *
 * @module components/Document/text/limits
 */
import type { DocumentLimits } from '../types'

/** The first limit `text` is past (characters, then lines), or null. */
export function overLimit(text: string, limits: DocumentLimits | undefined): 'chars' | 'lines' | null {
  if (limits?.maxChars !== undefined && text.length > limits.maxChars) return 'chars'
  if (limits?.maxLines !== undefined && text.split('\n').length > limits.maxLines) return 'lines'
  return null
}
