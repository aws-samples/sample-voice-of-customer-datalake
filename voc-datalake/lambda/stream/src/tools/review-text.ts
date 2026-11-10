/**
 * Review text as the assistant shows and quotes it: without the markdown escapes (`situation\.On`)
 * and `**` markers some review pages leave in stored text. Display only; nothing is written back.
 *
 * The same rules as the SPA's `frontend/src/utils/cleanReviewText.ts` and the Web Reviews ingestor's
 * `plugins/web_reviews/ingestor/review_text.py`; `review-text.test.ts` pins them to the shared
 * `schemas/review-text-cleanup-cases.json`.
 */

/** `\.` or `\!` right before a capital letter: the escape glued two sentences, so the space comes back. */
const ESCAPED_SENTENCE_END = /\\([.!])(?=\p{Lu})/gu;
/** Markdown may escape any ASCII punctuation; the backslash goes, the mark stays. */
const ESCAPED_ASCII_PUNCTUATION = /\\([!-/:-@[-`{-~])/gu;

/** `text` as plain text; anything that is not markdown residue is kept as is. */
export function plainReviewText(text: string): string {
  const withoutBold = text.replaceAll('**', '');
  return withoutBold.replaceAll(ESCAPED_SENTENCE_END, '$1 ').replaceAll(ESCAPED_ASCII_PUNCTUATION, '$1');
}

/** The customer-text fields a feedback record carries. */
const REVIEW_TEXT_FIELDS = ['original_text', 'normalized_text', 'title', 'direct_customer_quote'] as const;

/** `record` with its customer-text fields as plain text (a copy; the record is not changed). */
export function withPlainReviewText<T extends Record<string, unknown>>(record: T): T {
  const out: T = { ...record };
  for (const key of REVIEW_TEXT_FIELDS) {
    const value = record[key];
    if (typeof value === 'string') Object.assign(out, { [key]: plainReviewText(value) });
  }
  return out;
}
