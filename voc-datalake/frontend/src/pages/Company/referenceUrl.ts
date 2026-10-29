/**
 * @fileoverview The link a design reference is added with: why it cannot be sent, and whether it is
 * already a reference.
 *
 * Mirrors the API so the form explains a refusal before anything is sent:
 * - `shared.company_context.https_url` — https only, at most 2,048 characters, no spaces, a
 *   non-empty host;
 * - for a live website also `shared.url_policy.validate_url` — no user name or password in the
 *   address, not localhost (private addresses are only known once the API resolves the name, so
 *   that one stays server-side);
 * - `shared.reference_urls.normalised_reference_url` — two addresses are the same reference when
 *   they differ only in the scheme's / host's case, a trailing dot, the default port, a trailing
 *   slash, the fragment or userinfo. The API's 409 is the gate; this only says it early.
 *
 * @module pages/Company/referenceUrl
 */
import type { DesignReference, ReferenceKind } from '../../api/designSystemApi'

const MAX_URL_CHARS = 2048
const HTTPS = 'https://'
const LOCAL_HOSTS: ReadonlySet<string> = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback'])

export type UrlProblem = 'tooLong' | 'notUrl' | 'notHttps' | 'noHost' | 'credentials' | 'localhost'

/** The authority part (between `https://` and the first `/`, `?` or `#`) as typed — URL() would hide userinfo. */
function typedAuthority(value: string): string {
  return value.slice(HTTPS.length).split(/[/?#]/, 1)[0] ?? ''
}

function parsedHost(value: string): string | null {
  return parsedUrl(value)?.hostname ?? null
}

/** The `https_url` rules every link kind shares; null when they pass. */
function linkProblem(value: string): UrlProblem | null {
  if (value.length > MAX_URL_CHARS) return 'tooLong'
  if (/\s/.test(value)) return 'notUrl'
  if (!value.toLowerCase().startsWith(HTTPS)) return typedScheme(value) === '' ? 'notUrl' : 'notHttps'
  if (typedAuthority(value) === '' || /^[/$.?#]/.test(value.slice(HTTPS.length))) return 'noHost'
  const host = parsedHost(value)
  if (host === null) return 'notUrl'
  return host === '' ? 'noHost' : null
}

/** The live-website extras of `validate_url` that need no name lookup. */
function websiteProblem(value: string): UrlProblem | null {
  if (typedAuthority(value).includes('@')) return 'credentials'
  const host = (parsedHost(value) ?? '').replace(/\.$/, '')
  return LOCAL_HOSTS.has(host) ? 'localhost' : null
}

/** Why the API would refuse `raw` as a `kind` reference's link, or null when it would take it ('' is null: nothing typed). */
export function referenceUrlProblem(raw: string, kind: ReferenceKind): UrlProblem | null {
  const value = raw.trim()
  if (value === '') return null
  return linkProblem(value) ?? (kind === 'website' ? websiteProblem(value) : null)
}

/** The scheme `raw` was typed with (`ftp` for `ftp://…`, lower-cased), or '' when it names none. */
export function typedScheme(raw: string): string {
  return /^([a-z][a-z\d+.-]*):\/\//i.exec(raw.trim())?.[1]?.toLowerCase() ?? ''
}

/** True while `raw` can still become an https link by typing on (`htt`, `https:/`), so no message yet. */
export function isTypingHttps(raw: string): boolean {
  const value = raw.trim().toLowerCase()
  return value.length <= HTTPS.length && HTTPS.startsWith(value)
}

const DEFAULT_PORTS: Readonly<Record<string, string>> = { 'https:': '443', 'http:': '80' }

function parsedUrl(value: string): URL | null {
  try {
    return new URL(value)
  } catch {
    return null
  }
}

function withoutTrailingSlashes(path: string): string {
  return path.endsWith('/') ? withoutTrailingSlashes(path.slice(0, -1)) : path
}

/** The comparison form of a link (see the module doc); the trimmed text when it is not a URL. */
export function normalizeReferenceUrl(raw: string): string {
  const value = raw.trim()
  const url = parsedUrl(value)
  if (url === null) return value
  // URL() already lower-cases the scheme and host and drops the default port; this also ignores the rest.
  const host = url.hostname.replace(/\.$/, '')
  const port = url.port === '' || url.port === DEFAULT_PORTS[url.protocol] ? '' : `:${url.port}`
  return `${url.protocol}//${host}${port}${withoutTrailingSlashes(url.pathname)}${url.search}`
}

/** The non-archived reference already pointing at `raw`, or null. */
export function duplicateReference(references: readonly DesignReference[], raw: string): DesignReference | null {
  if (raw.trim() === '') return null
  const wanted = normalizeReferenceUrl(raw)
  return references.find((r) => r.status !== 'archived' && r.url !== undefined && normalizeReferenceUrl(r.url) === wanted) ?? null
}
