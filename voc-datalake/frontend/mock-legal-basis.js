// Dev mock: the legal basis every customer-data delete states (lambda/shared/legal_basis.py).
// Shared by mock-dimensions.js (POST /settings/erasure, PUT /settings/sources) and
// mock-participants.js (DELETE /participants/people/{id}).

const MAX_LEGAL_BASIS_CHARS = 300;
// The server refuses a basis that holds personal data (shared/pii_redaction.has_pattern_pii: email, phone,
// card, IBAN, IP). The mock approximates only the two an admin is likely to type, so a dev run sees that 400
// too: a word with one "@" and a dot after it, or ONE contiguous run (digits joined by spaces, dots, dashes or
// brackets; a letter ends it) of 9+ digits that starts with "+" or holds a separator. Card, IBAN and IP are not
// covered. A date ("2026-11-03", 8 digits) or a bare ticket number ("#123456789", no separator) passes.
const hasEmail = (text) => text.split(/\s+/).some((word) => {
  const at = word.indexOf('@');
  return at > 0 && word.indexOf('@', at + 1) === -1 && word.slice(at + 1).includes('.');
});
const PHONE_SEPARATORS = new Set([' ', '.', '-', '(', ')']);
function hasPhone(text) {
  let digits = 0;
  let separated = false;
  let pending = false; // a separator after a digit, or a leading "+", counts once another digit follows it
  for (const char of `${text}#`) {
    if (char >= '0' && char <= '9') {
      digits += 1;
      if (pending) separated = true;
      pending = false;
    } else if ((PHONE_SEPARATORS.has(char) && digits > 0) || (char === '+' && digits === 0)) {
      pending = true;
    } else {
      if (digits >= 9 && separated) return true;
      digits = 0;
      separated = false;
      pending = false;
    }
  }
  return false;
}

/** The real 400 message for a missing / blank / over-long / personal `value`, or null when it is a valid basis. */
export function legalBasisError(value, what = 'legal_basis') {
  const basis = typeof value === 'string' ? value.trim() : '';
  if (!basis) return `${what} is required: say why this data is deleted (for example "GDPR art. 17 request")`;
  if (basis.length > MAX_LEGAL_BASIS_CHARS) return `${what} must be at most ${MAX_LEGAL_BASIS_CHARS} characters`;
  return hasEmail(basis) || hasPhone(basis)
    ? `${what} must not contain personal data (an email, phone number or similar): it is kept on permanent audit rows; use a case or ticket number instead`
    : null;
}
