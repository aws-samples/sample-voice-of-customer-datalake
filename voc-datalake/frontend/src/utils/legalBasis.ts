/**
 * @fileoverview The legal basis every customer-data delete states (TENETS.md D5;
 * the server side is `lambda/shared/legal_basis.py`): a non-blank text of at most
 * `MAX_LEGAL_BASIS_CHARS` characters, holding no personal data.
 *
 * @module utils/legalBasis
 */

import { looksLikeEmail } from './looksLikeEmail'

/** `shared/legal_basis.py` MAX_LEGAL_BASIS_CHARS. */
export const MAX_LEGAL_BASIS_CHARS = 300

/** A phone-like run needs at least this many digits (a date has 8). */
const MIN_PHONE_DIGITS = 9
/** A digit, optionally led by "+" or "(", then digits and the separators people type in a phone number. */
const DIGIT_RUN = /[+(]?\d[\d .()-]*/g
const PHONE_SEPARATOR = /[ .()-]/
/** Punctuation a sentence wraps a word in ("(someone@example.com).") that is not part of an address. */
const LEADING_PUNCTUATION = new Set(['(', '"', "'", '<'])
const TRAILING_PUNCTUATION = new Set([')', '"', "'", '>', '.', ',', ';', ':', '!', '?'])

/** `word` without the punctuation around it (a linear scan, no backtracking regex; the marks are ASCII). */
function unwrapped(word: string): string {
  const chars = word.split('')
  const start = chars.findIndex((char) => !LEADING_PUNCTUATION.has(char))
  if (start === -1) return ''
  const trailing = chars.slice().reverse().findIndex((char) => !TRAILING_PUNCTUATION.has(char))
  return word.slice(start, word.length - trailing)
}

function looksLikePhone(run: string): boolean {
  const digits = run.replaceAll(/\D/g, '').length
  return digits >= MIN_PHONE_DIGITS && (run.startsWith('+') || PHONE_SEPARATOR.test(run.trim()))
}

/**
 * Whether `value` holds an email address or a phone number. A client-side approximation of the
 * server's `pii_redaction.has_pattern_pii` (which also refuses cards, IBANs and IP addresses, and
 * stays the authority): a word shaped like an address (`looksLikeEmail`), or a run of 9+ digits
 * that starts with "+" or is broken by spaces, dots, dashes or brackets. A date ("2026-11-03") or
 * a bare ticket number ("#123456789") passes.
 */
export function hasContactData(value: string): boolean {
  if (value.split(/\s+/).some((word) => looksLikeEmail(unwrapped(word)))) return true
  return [...value.matchAll(DIGIT_RUN)].some(([run]) => looksLikePhone(run))
}

/** Whether `value` is a legal basis the server accepts (non-blank, within the limit, no email or phone). */
export function isLegalBasis(value: string): boolean {
  const text = value.trim()
  return text !== '' && text.length <= MAX_LEGAL_BASIS_CHARS && !hasContactData(text)
}
