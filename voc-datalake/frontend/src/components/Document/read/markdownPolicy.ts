/**
 * @fileoverview The one safe-Markdown policy every rendered text goes through (docs/kiro-design-system.md →
 * Documents). Nothing here ever renders raw HTML: there is no `rehype-raw` and no `dangerouslySetInnerHTML` under
 * components/Document (ESLint), react-markdown turns any HTML it meets into text, and the reader's own pass
 * (remarkParity) shows it first as its inert source, as the canvas does. The CSP (`img-src 'self' data:`) stays the
 * backstop.
 *
 * - `stored`: text people stored (documents, versions, the review page). Links only where the canvas would write
 *   them (`isSafeHref`: http(s), mailto, paths in the app; never `javascript:`, `data:` or `//host`): external ones
 *   open in a new tab without opener or referrer, in-app ones navigate in place. Images only from a safe address,
 *   never `data:`; any other image shows its alt text (StoredParts.tsx).
 * - `model`: text a model or an agent wrote that nobody approved yet (the assistant's pending edit): SafeLink's
 *   links (http(s) and in-app paths), and no images at all, so nothing it wrote is fetched before anyone approved it.
 *
 * Later steps add the release notes' and the PDF's policies here as their renderers adopt it.
 *
 * @module components/Document/read/markdownPolicy
 */
import { defaultUrlTransform } from 'react-markdown'
import { isSafeHref } from '../edit/markdown/links'
import { NoImage, SafeLink } from './SafeLink'
import { StoredImage, StoredLink, TaskBox } from './StoredParts'
import type { Components, UrlTransform } from 'react-markdown'

export interface MarkdownPolicy {
  /** Every href and src is checked here first: an unsafe one becomes '' (and its element plain text). */
  readonly urlTransform: UrlTransform
  readonly components: Components
}

/** react-markdown's own rule (http(s), mailto … kept; `javascript:` and the like emptied), then the canvas's. */
const storedUrls: UrlTransform = (url) => (isSafeHref(url) ? defaultUrlTransform(url) : '')

export const markdownPolicy = {
  stored: { urlTransform: storedUrls, components: { a: StoredLink, img: StoredImage, input: TaskBox } },
  model: { urlTransform: defaultUrlTransform, components: { a: SafeLink, img: NoImage, input: TaskBox } },
} as const satisfies Readonly<Record<string, MarkdownPolicy>>
