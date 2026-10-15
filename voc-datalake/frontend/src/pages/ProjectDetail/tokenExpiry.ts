/**
 * Token-expiry presets and display derivation for the MCP Access tab.
 *
 * Its own module (like autoseedSelection.ts) rather than living in
 * McpAccessComponents.tsx: these are pure values/functions shared by the tab
 * and the components, and react-refresh requires component files to export
 * only components.
 */

/**
 * Lifetime presets offered at mint time. 'never' omits `expires_in_days` from
 * the request entirely, which the backend reads as a non-expiring token —
 * exactly what every pre-expiry caller gets. The numeric choices sit inside
 * the API's strict 1..365 bound, so the select cannot produce a 400.
 */
export const TOKEN_EXPIRY_CHOICES = ['never', '30', '90', '365'] as const
export type TokenExpiryChoice = (typeof TOKEN_EXPIRY_CHOICES)[number]

export function isTokenExpiryChoice(value: string): value is TokenExpiryChoice {
  return TOKEN_EXPIRY_CHOICES.some((choice) => choice === value)
}

/**
 * How a token's expiry renders in the list. Derived, not stored: 'expired'
 * mirrors what the backend now enforces at auth time, so a row the server
 * refuses never shows as quietly usable. 'soon' is a 7-day warning window.
 * An unreadable value claims nothing rather than something wrong.
 */
export function tokenExpiryState(expiresAt: string | null | undefined): 'none' | 'ok' | 'soon' | 'expired' {
  if (expiresAt == null || expiresAt === '') return 'none'
  const at = new Date(expiresAt).getTime()
  if (Number.isNaN(at)) return 'none'
  const msLeft = at - Date.now()
  if (msLeft <= 0) return 'expired'
  if (msLeft <= 7 * 24 * 60 * 60 * 1000) return 'soon'
  return 'ok'
}
