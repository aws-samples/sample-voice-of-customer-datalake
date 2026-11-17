/** The links the canvas writes and renders: http(s), mailto and paths inside the app. Never javascript: or data:. */
const SAFE_SCHEMES = new Set(['http', 'https', 'mailto'])

/** Browsers ignore ASCII whitespace and control characters inside a URL (`java\tscript:`), so the check does too. */
const strip = (url: string) => url.replace(/[\s\p{Cc}]/gu, '')

export function isSafeHref(url: string): boolean {
  const compact = strip(url)
  if (compact === '') return false
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(compact)?.[1]?.toLowerCase()
  if (scheme === undefined) return isAppPath(compact)
  return SAFE_SCHEMES.has(scheme)
}

/**
 * A scheme-less address is a path in the app only when no browser can read it as another host: `//host/x` is
 * protocol-relative and browsers read a backslash as a slash (`\\host`, `/\host`), so neither counts. What is left:
 * `/path`, `#part`, `?query` and a relative path with no `//` in it.
 */
const isAppPath = (url: string): boolean =>
  !url.startsWith('//') && !url.includes('\\') && (/^[/#?]/.test(url) || !url.includes('//'))

/**
 * What the user typed in the link editor, as the href to store (null: refused): `name@example.com` gets
 * mailto:, `example.com/x` gets https://, a path or a full http(s)/mailto URL stays as typed.
 */
export function normalizeHref(input: string): string | null {
  const url = input.trim()
  if (url === '' || /\s/.test(url)) return null
  if (/^[^@/:]+@[\w-]+(?:\.[\w-]+)+$/.test(url)) return `mailto:${url}`
  const bareDomain = /^[\w-]+(?:\.[\w-]+)+(?::\d+)?(?:[/?#]|$)/.test(url)
  const href = bareDomain ? `https://${url}` : url
  return isSafeHref(href) ? href : null
}
