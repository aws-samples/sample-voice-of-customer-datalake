/**
 * @fileoverview Option codes and the ids of questions, endings and hidden fields (contract: `^[a-z0-9_]{1,40}$`,
 * `^q_[a-z0-9_]{1,40}$`, `^end_[a-z0-9_]{1,40}$`, `^[a-z][a-z0-9_]{0,39}$`).
 *
 * A code is made from its option's primary-language label when the option is created (UX §4.1): lower case, accents
 * folded (ą→a, ł→l, ß→ss, é→e…), anything else `_`, repeats collapsed, trimmed to 40 characters; a clash gets `_2`,
 * `_3`. `other` and `none` are reserved for the Other and None rows (D3). The server makes the AI's codes the same way.
 * No hidden field is `__proto__`, `constructor` or `prototype` (shared/forms_v2.py `RESERVED_HIDDEN_IDS`):
 * the widget never fills those.
 *
 * @module pages/FeedbackForms/model/codes
 */

const MAX_CODE = 40
const RESERVED_CODES: readonly string[] = ['other', 'none']
const RESERVED_HIDDEN_IDS: readonly string[] = ['__proto__', 'constructor', 'prototype']

const CODE = /^[a-z0-9_]{1,40}$/
const QUESTION_ID = /^q_[a-z0-9_]{1,40}$/
const ENDING_ID = /^end_[a-z0-9_]{1,40}$/
const HIDDEN_ID = /^[a-z][a-z0-9_]{0,39}$/

export const isValidCode = (code: string): boolean => CODE.test(code)
export const isReservedCode = (code: string): boolean => RESERVED_CODES.includes(code)
export const isValidQuestionId = (id: string): boolean => QUESTION_ID.test(id)
export const isValidEndingId = (id: string): boolean => ENDING_ID.test(id)
export const isValidHiddenId = (id: string): boolean => HIDDEN_ID.test(id)
export const isReservedHiddenId = (id: string): boolean => RESERVED_HIDDEN_IDS.includes(id)

/** Letters NFD does not split into a base and a mark. */
const SPECIAL_FOLDS: Readonly<Record<string, string>> = {
  ł: 'l', Ł: 'l', ß: 'ss', ø: 'o', Ø: 'o', æ: 'ae', Æ: 'ae', œ: 'oe', Œ: 'oe', đ: 'd', Đ: 'd', ı: 'i', þ: 'th', ð: 'd',
}

const SPECIAL_LETTERS = /[łŁßøØæÆœŒđĐıþð]/gu

/** `text` with its accents folded away (ą→a, ż→z, ł→l, ß→ss). */
export function foldAccents(text: string): string {
  return text.replace(SPECIAL_LETTERS, (char) => SPECIAL_FOLDS[char] ?? char).normalize('NFD').replace(/\p{M}/gu, '')
}

/** `text`'s runs of `[a-z0-9]` joined by single underscores (no leading, trailing or repeated `_`). */
const joinedWords = (text: string): string => text.split(/[^a-z0-9]/).filter((word) => word !== '').join('_')

/** The slug of `text` (`[a-z0-9_]`, at most `max` characters), '' when nothing is left. */
export function codeSlug(text: string, max = MAX_CODE): string {
  return joinedWords(joinedWords(foldAccents(text).toLowerCase()).slice(0, max))
}

/** `base`, or `base` with `_2`, `_3`… after it: the first that is not taken (nor reserved), within `max` characters. */
export function uniqueSlug(base: string, taken: ReadonlySet<string>, max = MAX_CODE): string {
  const free = (candidate: string) => !taken.has(candidate) && !isReservedCode(candidate)
  if (free(base)) return base
  const suffixed = (n: number) => `${joinedWords(base.slice(0, max - String(n).length - 1))}_${String(n)}`
  const n = Array.from({ length: taken.size + 2 }, (_unused, index) => index + 2).find((candidate) => free(suffixed(candidate)))
  return suffixed(n ?? taken.size + 2)
}

/** A new option code from its label, unique among `taken`. An unlabelled option is `option`, `option_2`… */
export function codeFromLabel(label: string, taken: ReadonlySet<string>): string {
  const base = codeSlug(label)
  return uniqueSlug(base === '' ? 'option' : base, taken)
}

/** A new id `<prefix><slug>` from `text` (or `fallback`), unique among `taken`. */
function prefixedId(prefix: string, text: string, fallback: string, taken: ReadonlySet<string>): string {
  const room = MAX_CODE
  const base = codeSlug(text, room)
  const bare = new Set([...taken].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length)))
  return `${prefix}${uniqueSlug(base === '' ? fallback : base, bare, room)}`
}

/** A new question id (`q_…`) from a hint (its type, or a headline), unique among `taken`. */
export const newQuestionId = (hint: string, taken: ReadonlySet<string>): string => prefixedId('q_', hint, 'question', taken)

/** A new ending id (`end_…`), unique among `taken`. */
export const newEndingId = (hint: string, taken: ReadonlySet<string>): string => prefixedId('end_', hint, 'ending', taken)

/** The id a duplicate of `id` gets: `<id>_2`, `<id>_3`… (UX §3.3). */
export function duplicateId(id: string, taken: ReadonlySet<string>): string {
  const prefix = id.startsWith('end_') ? 'end_' : 'q_'
  const bare = new Set([...taken].filter((other) => other.startsWith(prefix)).map((other) => other.slice(prefix.length)))
  const base = id.slice(prefix.length)
  // (the original's own id counts as taken, so the copy is at least `_2`)
  return `${prefix}${uniqueSlug(base, new Set([...bare, base]))}`
}
