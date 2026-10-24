/**
 * @fileoverview Link and image renderers for model-written markdown.
 *
 * The model's text can carry links that came from feedback, web results or
 * project documents — none of which we wrote. Only two kinds of href are
 * rendered as links: absolute http(s) URLs (new tab, no opener/referrer, no
 * follow; an external-link icon marks them, and the tooltip and the accessible
 * name say where they go — wave 4 dropped the visible "(example-air.example)" suffix
 * that repeated the host after every citation) and in-app
 * paths starting with a single `/` (client-side navigation). Everything else —
 * `javascript:`, `data:`, protocol-relative `//host`, relative paths, mailto —
 * renders as plain text. Images are not rendered at all (no tracking pixels,
 * no remote fetches triggered by model output). A bare URL the model wrote as
 * its own text reads as a short "host/path" (the full URL stays in the tooltip),
 * so a long address never runs across the answer.
 *
 * @module assistant/components/SafeLink
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ExternalLink } from 'lucide-react'
import { classifyHref } from './safeHref'
import ReviewLink from '../../components/ReviewLink/ReviewLink'
import { leaveFullscreenOnPlainClick } from '../../hooks/useRouteNavigate'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'

const LINK_CLASS = 'text-accent-text underline decoration-accent-text/45 hover:decoration-accent-text'

type AnchorProps = ComponentPropsWithoutRef<'a'>

/** A bare URL is shown at most this long. */
const MAX_URL_TEXT = 48

/** "example-air.example/changelog/2026-06-11-coding…": the host without www, then the path, cut short. */
function shortUrlText(href: string): string {
  const url = new URL(href)
  const text = `${url.hostname.replace(/^www\./u, '')}${url.pathname === '/' ? '' : url.pathname}`
  return text.length > MAX_URL_TEXT ? `${text.slice(0, MAX_URL_TEXT - 1)}…` : text
}

/** The link text the model wrote is the URL itself (GFM autolinks a bare URL). */
function isBareUrl(children: ReactNode, href: string): boolean {
  if (typeof children !== 'string') return false
  const text = children.trim()
  return text === href || `${text}/` === href || href.endsWith(`//${text}`) || href.endsWith(`//${text}/`)
}

function ExternalAnchor({ href, host, children }: Readonly<{ href: string; host: string; children: ReactNode }>) {
  const { t } = useTranslation('assistant')
  const bare = isBareUrl(children, href)
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" title={href} className={LINK_CLASS}>
      {bare ? shortUrlText(href) : children}
      <ExternalLink size={12} className="ml-0.5 inline-block align-baseline" aria-hidden />
      <span className="sr-only"> {t('message.externalLink', { host: host.replace(/^www\./u, '') })}</span>
    </a>
  )
}

/**
 * `/feedback/<id>` opens the review modal over the page (and over the full-screen assistant);
 * any other in-app path is a real route change, so a plain click leaves full screen first.
 */
export function SafeLink({ href, children }: Readonly<AnchorProps>) {
  const target = classifyHref(href)
  if (target.kind === 'review') {
    return <ReviewLink feedbackId={target.feedbackId} className={LINK_CLASS}>{children}</ReviewLink>
  }
  if (target.kind === 'internal') {
    return <Link to={target.path} className={LINK_CLASS} onClick={leaveFullscreenOnPlainClick}>{children}</Link>
  }
  if (target.kind === 'external') {
    return <ExternalAnchor href={target.href} host={target.host}>{children}</ExternalAnchor>
  }
  return <span>{children}</span>
}

export function NoImage() {
  return null
}
