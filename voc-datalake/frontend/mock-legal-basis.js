// Dev mock: the legal basis every customer-data delete states (lambda/shared/legal_basis.py).
// Shared by mock-dimensions.js (POST /settings/erasure, PUT /settings/sources) and
// mock-participants.js (DELETE /participants/people/{id}).

const MAX_LEGAL_BASIS_CHARS = 300;
// The server refuses a basis that holds personal data (shared/pii_redaction.has_pattern_pii: email, phone,
// card, IBAN, IP). The mock checks the two an admin is likely to type, so a dev run sees that 400 too:
// a word with "@" and a dot after it, or a run of 9+ digits (spaces, dots, dashes, brackets allowed between).
const hasEmail = (text) => text.split(/\s+/).some((word) => {
  const at = word.indexOf('@');
  return at > 0 && word.indexOf('@', at + 1) === -1 && word.slice(at + 1).includes('.');
});
const hasPhone = (text) => /\d{9,}/.test(text.replace(/[\s.()+-]/g, ''));

/** The real 400 message for a missing / blank / over-long / personal `value`, or null when it is a valid basis. */
export function legalBasisError(value, what = 'legal_basis') {
  const basis = typeof value === 'string' ? value.trim() : '';
  if (!basis) return `${what} is required: say why this data is deleted (for example "GDPR art. 17 request")`;
  if (basis.length > MAX_LEGAL_BASIS_CHARS) return `${what} must be at most ${MAX_LEGAL_BASIS_CHARS} characters`;
  return hasEmail(basis) || hasPhone(basis)
    ? `${what} must not contain personal data (an email, phone number or similar): it is kept on permanent audit rows; use a case or ticket number instead`
    : null;
}
