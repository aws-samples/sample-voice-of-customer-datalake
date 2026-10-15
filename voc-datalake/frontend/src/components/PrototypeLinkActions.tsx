/**
 * @fileoverview Opening a prototype outside the app, and saying how long that
 * remains possible.
 *
 * Extracted from the Documents tab because the Prioritization row now needs the
 * same thing — the same move `PrototypeRenderer` and `parsePrototypeSpec` already
 * made for that page. The wording, the deadline, the aria wiring and the reason
 * these are anchors are all one decision, and the second copy would be the one
 * that quietly loses a piece of it.
 *
 * ## These are anchors, and must stay anchors
 *
 * A prototype is served from `/prototypes/*`, a cache behavior restricted by a
 * trusted key group, so the URL is a signed, session-scoped credential that the
 * app replaces before it lapses (see `prototypeLinkLifetime`). The temptation is
 * to make "Open in new tab" a button that fetches a fresh signature first. That
 * trades one failure for a worse one: a browser navigates the instant an anchor
 * is clicked, so nothing can intervene, and a button that awaits a fetch and then
 * calls `window.open` is a popup the browser blocks — `download` cannot be
 * triggered that way at all. Freshness is therefore the refresh scheduler's job
 * (`usePrototypeLinkRefresh`), not the click handler's, and there is no click
 * handler here on purpose.
 *
 * ## The deadline is stated, not implied
 *
 * A signed URL copied out of "Open in new tab" and passed to a colleague dies
 * inside the hour with no explanation at either end. So the note says when, in
 * visible text — not a `title`, which is hover-only, invisible on touch and
 * announced inconsistently — and the anchors point at it with
 * `aria-describedby`, so the warning reaches a screen-reader user at the moment
 * they are about to activate the link.
 *
 * The deadline is read off the URL's own `Expires` rather than from a TTL constant
 * mirrored here. The signer's TTL is a Python-side fallback
 * (`CDN_SIGNED_URL_TTL_SECONDS` is not set in the stack), so a number hardcoded on
 * this side would be a guess that silently diverges the day it is configured.
 *
 * The note and the anchors are separate exports rather than one component,
 * because the two pages place them differently: the Documents tab puts the note
 * beside "Live preview" on the left with the actions on the right, while the
 * narrow Prioritization column stacks the note under its link. The id that ties
 * them together is minted by the caller with `useId` for that reason — and
 * because a page can show several prototypes, so a module constant would collide.
 *
 * @module components/PrototypeLinkActions
 */
import clsx from 'clsx'
import { Clock } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { signedUrlExpiresAt, formatExpiry } from './prototypeLinkLifetime'
import { useDeadlinePassed } from './useDeadlinePassed'
import type { ReactElement } from 'react'

/**
 * How long this prototype link lasts, or nothing at all when that cannot be read.
 *
 * @param url the signed prototype URL.
 * @param noteId minted by the caller with `useId` and also handed to
 *   `PrototypeLinkActions`, which puts it on the anchors' `aria-describedby`.
 * @param className sizing and spacing from the caller, whose surrounding type
 *   scale this component has no way to know.
 */
export function PrototypeLinkLifetimeNote({
  url, noteId, className,
}: {
  readonly url: string
  readonly noteId: string
  readonly className?: string
}): ReactElement | null {
  const { t, i18n } = useTranslation('components')
  const expiresAt = signedUrlExpiresAt(url)

  // Flips itself at the deadline via a single timer, so the label cannot keep
  // promising a window that has already closed. Reading `Date.now()` here instead
  // would be impure (eslint's react-hooks/purity), and sampling it once in state
  // would freeze the answer for as long as the pane stays mounted.
  const expired = useDeadlinePassed(expiresAt)

  // Only decides whether the deadline falls on today's date, which does not change
  // meaningfully within a one-hour window — and if the page is open across midnight,
  // a sample from before it errs toward SHOWING the date, which is the safe way to be
  // wrong. Hooks precede the guard below because they cannot be conditional.
  const [sampledNow] = useState(() => Date.now())

  // No readable deadline — an unsigned or malformed URL. Say nothing rather than
  // invent a window: a wrong expiry is worse than none.
  if (expiresAt == null) return null

  return (
    <span
      id={noteId}
      className={clsx('inline-flex items-start gap-1', expired ? 'text-amber-700' : 'text-gray-400', className)}
    >
      <Clock size={11} className="flex-shrink-0 mt-0.5" />
      {/* Wraps rather than truncates. Under `truncate` the clipped end was the hint —
          i.e. the sentence this label exists for — so a narrow pane silently put the
          warning back out of sight for sighted users. */}
      <span>
        {expired
          ? t('prototypeLink.linkExpired')
          : t('prototypeLink.linkExpires', { time: formatExpiry(expiresAt, sampledNow, i18n.language) })}
        {' · '}
        {/* Visible rather than a `title`: this warning is the whole point of the
            label, and a tooltip is hover-only — invisible on touch, and announced
            inconsistently. */}
        {t('prototypeLink.linkExpiryHint')}
      </span>
    </span>
  )
}

/**
 * Open (and optionally download) a prototype from its signed CDN URL.
 *
 * @param url the signed prototype URL. Only pass one that exists — a legacy
 *   prototype has no URL, and its inline HTML needs the blob path instead.
 * @param noteId the id `PrototypeLinkLifetimeNote` was rendered with.
 * @param downloadName base filename (no extension) for a "Download .html" anchor.
 *   Omit it to offer opening only, which is all the Prioritization row wants — a
 *   reviewer scanning a pitch is not filing artifacts.
 */
export default function PrototypeLinkActions({
  url, noteId, downloadName,
}: {
  readonly url: string
  readonly noteId: string
  readonly downloadName?: string
}): ReactElement {
  const { t } = useTranslation('components')
  // Reference the note only when it will actually render, so `aria-describedby`
  // never dangles on an id that is not in the document. Same predicate the note
  // itself returns null on, from the same shared helper.
  const describedBy = signedUrlExpiresAt(url) == null ? undefined : noteId
  return (
    <>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-blue-600 hover:underline"
        aria-describedby={describedBy}
      >
        {t('prototypeLink.openNewTab')}
      </a>
      {downloadName === undefined ? null : (
        <a
          href={url}
          download={`${downloadName}.html`}
          className="text-blue-600 hover:underline"
          aria-describedby={describedBy}
        >
          {t('prototypeLink.downloadHtml')}
        </a>
      )}
    </>
  )
}
