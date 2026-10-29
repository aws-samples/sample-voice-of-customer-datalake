/**
 * @fileoverview Client-side checks on what a user types for a person (the server stays the
 * authority; these only spare a round trip and say what is wrong next to the field).
 * @module pages/Participants/participantInput
 */

/** A plausible single address: one `@`, no spaces, a dotted domain. Linear, no regex backtracking. */
export function isPlausibleEmail(value: string): boolean {
  const email = value.trim()
  if (email === '' || /\s/.test(email)) return false
  const [local = '', domain = '', ...rest] = email.split('@')
  return rest.length === 0 && local !== '' && isPlausibleDomain(domain)
}

/** A dotted host name with no empty label (`example.com`, `mail.acme.example`). */
export function isPlausibleDomain(value: string): boolean {
  const labels = value.trim().toLowerCase().split('.')
  return labels.length >= 2 && labels.every((label) => /^[a-z0-9-]+$/.test(label) && !label.startsWith('-') && !label.endsWith('-'))
}

/** Tags typed as one comma-separated line, trimmed and de-duplicated. */
export function parseTags(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== ''))]
}
