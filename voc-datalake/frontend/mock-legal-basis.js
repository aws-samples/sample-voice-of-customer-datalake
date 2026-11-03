// Dev mock: the legal basis every customer-data delete states (lambda/shared/legal_basis.py).
// Shared by mock-dimensions.js (POST /settings/erasure, PUT /settings/sources) and
// mock-participants.js (DELETE /participants/people/{id}).

export const MAX_LEGAL_BASIS_CHARS = 300;

/** The real 400 message for a missing / blank / over-long `value`, or null when it is a valid basis. */
export function legalBasisError(value, what = 'legal_basis') {
  const basis = typeof value === 'string' ? value.trim() : '';
  if (!basis) return `${what} is required: say why this data is deleted (for example "GDPR art. 17 request")`;
  return basis.length > MAX_LEGAL_BASIS_CHARS ? `${what} must be at most ${MAX_LEGAL_BASIS_CHARS} characters` : null;
}
