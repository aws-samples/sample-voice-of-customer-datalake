// Shared by the Connect mocks (mock-connect.js: personal tokens; mock-oauth.js: OAuth sign-ins). Both
// credential kinds follow shared/mcp_global_tokens.token_status: revoked, else active until expires_at.

const DAY_MS = 86_400_000;

/** An ISO time `days` from now (negative = in the past). */
export const isoIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString();

/** `active` | `revoked` | `expired`, failing closed like the backend (no deadline = expired). */
export function credentialStatus(row) {
  if (row.revoked_at) return 'revoked';
  return row.expires_at && Date.parse(row.expires_at) > Date.now() ? 'active' : 'expired';
}
