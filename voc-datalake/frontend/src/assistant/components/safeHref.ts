/**
 * @fileoverview Which hrefs in model-written markdown may become links (see SafeLink).
 *
 * @module assistant/components/safeHref
 */
export type SafeHref =
  | { kind: 'external'; href: string; host: string }
  | { kind: 'internal'; path: string }
  | { kind: 'unsafe' }

export function classifyHref(href: string | undefined): SafeHref {
  const raw = (href ?? '').trim()
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) return { kind: 'internal', path: raw }
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' || url.protocol === 'http:') return { kind: 'external', href: url.href, host: url.hostname }
  } catch {
    // Not an absolute URL.
  }
  return { kind: 'unsafe' }
}
