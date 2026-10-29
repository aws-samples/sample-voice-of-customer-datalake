/**
 * @fileoverview The one https-link check the SPA uses before it sends or renders a link: a board's
 * `link` field (the only board text rendered as a link) and an ask's survey URL.
 * @module utils/httpsUrl
 */

/** An absolute `https:` URL with a host and no whitespace. */
export function isHttpsUrl(value: string): boolean {
  if (/\s/.test(value) || !URL.canParse(value)) return false
  const url = new URL(value)
  return url.protocol === 'https:' && url.hostname !== ''
}
