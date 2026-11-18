/**
 * @fileoverview How the stored-text policy (markdownPolicy.ts) renders a link, an image and a to-do's box.
 *
 * @module components/Document/read/StoredParts
 */
import { useTranslation } from 'react-i18next'
import { isSafeHref, isSafeImageSrc } from '../edit/markdown/links'
import { SafeLink } from './SafeLink'
import type { ComponentPropsWithoutRef } from 'react'

/** The canvas's link look (the same rule as `.md-content a`). */
const LINK_CLASS = 'text-accent-text underline decoration-accent-text/45 hover:decoration-accent-text'

/** Browsers ignore whitespace and control characters inside a URL: the address as a browser reads it. */
const compact = (url: string) => url.replace(/[\s\p{Cc}]/gu, '')

/** A link in stored text: http(s) and in-app paths as the assistant's links read; mailto, `#part`, `?query` plain. */
export function StoredLink({ href, children }: Readonly<ComponentPropsWithoutRef<'a'>>) {
  const url = compact(href ?? '')
  if (!isSafeHref(url)) return <span>{children}</span>
  if (/^(?:https?:|\/)/iu.test(url)) return <SafeLink href={url}>{children}</SafeLink>
  return <a href={url} className={LINK_CLASS}>{children}</a>
}

/** An image in stored text: only from a safe web or in-app address; otherwise its alt text. */
export function StoredImage({ src, alt }: Readonly<ComponentPropsWithoutRef<'img'>>) {
  const url = typeof src === 'string' ? compact(src) : ''
  if (!isSafeImageSrc(url)) return alt === undefined || alt === '' ? null : <span>{alt}</span>
  return <img src={url} alt={alt ?? ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" />
}

/** A to-do's box: read only, named as the canvas names it, and (like the canvas's) not part of the text. */
export function TaskBox({ type, checked }: Readonly<ComponentPropsWithoutRef<'input'>>) {
  const { t } = useTranslation('documents')
  if (type !== 'checkbox') return null
  return <input type="checkbox" checked={checked === true} readOnly disabled aria-label={t('editor.task')} data-anchor-skip="" />
}
