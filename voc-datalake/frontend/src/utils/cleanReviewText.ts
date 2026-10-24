/**
 * @fileoverview Display-time cleanup of scraped review text. Some review pages hand back
 * markdown-escaped text ("Works great\. 5\* service") or bold markers left over from the
 * page ("**Great** app"). Shown as typed by the customer, without them. The stored text is
 * never changed: this runs at render only.
 *
 * @module utils/cleanReviewText
 */

/** A backslash escaping one ASCII punctuation mark (markdown escape): `\.` `\*` `\-` `\!` … */
const MARKDOWN_ESCAPE = /\\([!-/:-@[-`{-~])/gu
/** Bold markers (`**`), paired or stray: plain text has no bold. */
const BOLD_MARKER = /\*\*/gu

/** `text` without markdown escapes and `**` markers; anything else is kept as is ('' for no text). */
export function cleanReviewText(text: string | null | undefined): string {
  if (typeof text !== 'string') return ''
  return text.replace(BOLD_MARKER, '').replace(MARKDOWN_ESCAPE, '$1')
}

/** `cleanReviewText` for a field that may be absent — or `null` on the wire despite its type. */
function cleanOptional<T>(text: T): T | string {
  return typeof text === 'string' ? cleanReviewText(text) : text
}

interface ReviewTexts {
  readonly original_text: string
  readonly normalized_text?: string
  readonly title?: string
  readonly direct_customer_quote?: string
  readonly problem_summary?: string
}

/** `item` with every customer-text field cleaned for display (a copy; the item is not changed). */
export function cleanFeedbackText<T extends ReviewTexts>(item: T): T {
  return {
    ...item,
    original_text: cleanOptional(item.original_text),
    normalized_text: cleanOptional(item.normalized_text),
    title: cleanOptional(item.title),
    direct_customer_quote: cleanOptional(item.direct_customer_quote),
    problem_summary: cleanOptional(item.problem_summary),
  }
}
