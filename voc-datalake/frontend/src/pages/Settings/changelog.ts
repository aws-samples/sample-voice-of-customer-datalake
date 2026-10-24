/**
 * @fileoverview Splits CHANGELOG.md into release sections for the Version tab,
 * and maps the changelog's links to safe targets.
 *
 * @module pages/Settings/changelog
 */

export interface ChangelogRelease {
  /** Heading text without the `## `, e.g. `[3.12.00] - 2026-10-09`. */
  readonly heading: string
  /** Markdown under the heading, up to the next release. */
  readonly body: string
}

/** Where relative links (`docs/…`, `CONTRIBUTING.md`) in the changelog point. */
const REPO_BLOB_BASE = 'https://github.com/aws-samples/sample-voice-of-customer-datalake/blob/main/'

const RELEASE_HEADING = /^## (.+)$/

/**
 * The `## ` sections of the changelog, in file order (newest first). The
 * preamble before the first section is dropped, and so is an `[Unreleased]`
 * section with nothing under it.
 */
export function splitReleases(markdown: string): ChangelogRelease[] {
  const releases: { heading: string; lines: string[] }[] = []
  for (const line of markdown.split('\n')) {
    const heading = RELEASE_HEADING.exec(line)?.[1]
    if (heading !== undefined) releases.push({ heading: heading.trim(), lines: [] })
    else releases.at(-1)?.lines.push(line)
  }
  return releases
    .map(({ heading, lines }) => ({ heading, body: lines.join('\n').trim() }))
    .filter(({ heading, body }) => !(isUnreleased(heading) && body === ''))
}

function isUnreleased(heading: string): boolean {
  return /^\[?unreleased\]?$/i.test(heading)
}

export type ChangelogLink =
  | { readonly kind: 'external'; readonly href: string }
  | { readonly kind: 'text' }

/**
 * An `http(s)` link opens in a new tab; a repo-relative path (`docs/x.md#y`)
 * becomes its GitHub blob URL; anything else (`#anchor`, `mailto:`, other
 * schemes, `../` escapes) renders as plain text.
 */
export function resolveChangelogLink(href: string | undefined): ChangelogLink {
  if (href === undefined || href === '') return { kind: 'text' }
  if (/^https?:\/\//i.test(href)) return { kind: 'external', href }
  // Another scheme, an in-page anchor, or a root/protocol-relative path: no safe target.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('/')) return { kind: 'text' }
  const path = href.replace(/^\.\//, '')
  if (path.split(/[/#?]/).includes('..')) return { kind: 'text' }
  return { kind: 'external', href: `${REPO_BLOB_BASE}${path}` }
}
