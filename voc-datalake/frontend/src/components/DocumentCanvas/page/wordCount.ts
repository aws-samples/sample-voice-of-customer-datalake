/**
 * @fileoverview How long a document reads: its words (the text a reader sees, not its Markdown marks, links' text
 * kept and their addresses dropped) and the minutes they take at an unhurried pace. A language written with spaces
 * counts what stands between them (any run holding a letter or a digit), which stays quick on a 200,000-character
 * document; Japanese and Chinese, written without them, count the language's own words (`Intl.Segmenter`).
 *
 * @module components/DocumentCanvas/page/wordCount
 */

/** An unhurried reading pace (words per minute) for working documents. */
export const WORDS_PER_MINUTE = 200

/** `text` without the addresses of its links and images (`](…)`), in one pass. */
function withoutTargets(text: string): string {
  const [head = '', ...after] = text.split('](')
  const rest = after.map((part) => {
    const end = part.indexOf(')')
    return end < 0 ? part : part.slice(end + 1)
  })
  return [head, ...rest].join(' ')
}

/** A fence (```, ~~~) or a table's rule line (| --- | :-: |): no words of its own. */
function isMarkupLine(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('```') || trimmed.startsWith('~~~') || (trimmed.includes('-') && /^[\s|:-]+$/.test(trimmed))
}

/** The text a reader sees: link and image addresses, fences, table rules and Markdown marks dropped. */
function readableText(markdown: string): string {
  const lines = markdown.split('\n').filter((line) => !isMarkupLine(line))
  return withoutTargets(lines.join('\n')).replaceAll(/[#>*_~`|[\]!]/g, ' ')
}

/** Languages written without spaces between words. */
const UNSPACED = /^(?:ja|zh)\b/i

/** A run of text that is a word: it holds a letter or a digit (not a lone dash or dot). */
const WORDLIKE = /[\p{L}\p{N}]/u

/** The words of `markdown` in `language`. */
export function countWords(markdown: string, language: string): number {
  const text = readableText(markdown)
  if (text.trim() === '') return 0
  if (!UNSPACED.test(language)) return text.split(/\s+/).filter((run) => WORDLIKE.test(run)).length
  const segmenter = new Intl.Segmenter(language, { granularity: 'word' })
  return [...segmenter.segment(text)].filter((segment) => segment.isWordLike === true).length
}

/** Whole minutes to read `words`, at least one for any text (none for an empty page). */
export function readingMinutes(words: number): number {
  return words === 0 ? 0 : Math.max(1, Math.round(words / WORDS_PER_MINUTE))
}
