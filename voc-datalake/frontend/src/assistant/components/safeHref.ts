/**
 * @fileoverview Which hrefs in model-written markdown may become links (see SafeLink).
 *
 * `/feedback/<id>` (one of our reviews, optionally with a query or fragment) is its own kind: it
 * opens the review modal over the page instead of navigating away from the conversation.
 *
 * @module assistant/components/safeHref
 */
export type SafeHref =
  | { kind: 'external'; href: string; host: string }
  | { kind: 'internal'; path: string }
  | { kind: 'review'; feedbackId: string }
  | { kind: 'unsafe' }

const REVIEW_PATH = /^\/feedback\/([^/?#]+)\/?(?:[?#].*)?$/u
const MAX_ID = 128

function decoded(segment: string): string | null {
  try {
    return decodeURIComponent(segment)
  } catch {
    return null
  }
}

function internal(path: string): SafeHref {
  const segment = REVIEW_PATH.exec(path)?.[1]
  const id = segment === undefined ? null : decoded(segment)
  return id !== null && id !== '' && id.length <= MAX_ID ? { kind: 'review', feedbackId: id } : { kind: 'internal', path }
}

export function classifyHref(href: string | undefined): SafeHref {
  const raw = (href ?? '').trim()
  if (raw.startsWith('/') && !raw.startsWith('//') && !raw.startsWith('/\\')) return internal(raw)
  try {
    const url = new URL(raw)
    if (url.protocol === 'https:' || url.protocol === 'http:') return { kind: 'external', href: url.href, host: url.hostname }
  } catch {
    // Not an absolute URL.
  }
  return { kind: 'unsafe' }
}
