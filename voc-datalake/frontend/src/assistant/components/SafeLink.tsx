/**
 * @fileoverview Link and image renderers for model-written markdown.
 *
 * The model's text can carry links that came from feedback, web results or
 * project documents — none of which we wrote. Only two kinds of href are
 * rendered as links: absolute http(s) URLs (new tab, no opener/referrer, no
 * follow, with the hostname shown so the user sees where it goes) and in-app
 * paths starting with a single `/` (client-side navigation). Everything else —
 * `javascript:`, `data:`, protocol-relative `//host`, relative paths, mailto —
 * renders as plain text. Images are not rendered at all (no tracking pixels,
 * no remote fetches triggered by model output).
 *
 * @module assistant/components/SafeLink
 */
import { Link } from 'react-router-dom'
import { classifyHref } from './safeHref'
import type { ComponentPropsWithoutRef } from 'react'

const LINK_CLASS = 'text-accent-text underline decoration-accent-text/45 hover:decoration-accent-text'

type AnchorProps = ComponentPropsWithoutRef<'a'> & { node?: unknown }

export function SafeLink({ href, children }: Readonly<AnchorProps>) {
  const target = classifyHref(href)
  if (target.kind === 'internal') {
    return <Link to={target.path} className={LINK_CLASS}>{children}</Link>
  }
  if (target.kind === 'external') {
    return (
      <a href={target.href} target="_blank" rel="noopener noreferrer nofollow" title={target.host} className={LINK_CLASS}>
        {children}
        <span className="text-[12px] text-muted"> ({target.host})</span>
      </a>
    )
  }
  return <span>{children}</span>
}

export function NoImage() {
  return null
}
