/**
 * @fileoverview The legal basis every customer-data delete states (TENETS.md D5;
 * the server side is `lambda/shared/legal_basis.py`): a non-blank text of at most
 * `MAX_LEGAL_BASIS_CHARS` characters.
 *
 * @module utils/legalBasis
 */

/** `shared/legal_basis.py` MAX_LEGAL_BASIS_CHARS. */
export const MAX_LEGAL_BASIS_CHARS = 300

/** Whether `value` is a legal basis the server accepts (non-blank, within the limit). */
export function isLegalBasis(value: string): boolean {
  const text = value.trim()
  return text !== '' && text.length <= MAX_LEGAL_BASIS_CHARS
}
