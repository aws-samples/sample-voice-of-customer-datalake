/**
 * @fileoverview "Copy link": copies a link that opens this review again. Replaces the raw
 * "ID: <hex>" line people had no use for; the id still travels inside the link.
 * Our review links to its own page (`/feedback/:id`); a Radar review has no page, so its link is
 * the address that opens it in the review modal (`?review=<id>&reviewBrand=<brand>`, which the
 * modal is driven by — hooks/useReviewModal).
 * @module pages/FeedbackDetail/CopyReviewLink
 */
import { Check, Link2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useLocation } from 'react-router-dom'
import { useCopiedFlag } from '../../hooks/useCopiedFlag'

/** The absolute URL of a review's page in this app. */
function reviewPageUrl(feedbackId: string, origin: string): string {
  return `${origin}/feedback/${encodeURIComponent(feedbackId)}`
}

/** The link for one review: its page, or (a Radar review) the current modal address without a hash. */
function reviewLink(feedbackId: string, radarPath: string | null): string {
  const { origin } = window.location
  return radarPath === null ? reviewPageUrl(feedbackId, origin) : `${origin}${radarPath}`
}

interface CopyReviewLinkProps {
  readonly feedbackId: string
  /** A Radar review: copy the modal's own address (it has no /feedback page). */
  readonly radar?: boolean
}

export default function CopyReviewLink({ feedbackId, radar = false }: CopyReviewLinkProps) {
  const { t } = useTranslation('feedbackDetail')
  const [copied, markCopied] = useCopiedFlag()
  // The router's location, not window.location: it is what `?review=&reviewBrand=` lives on.
  const { pathname, search } = useLocation()
  const copy = () => {
    // A refused clipboard leaves the label as it was: nothing was copied.
    void navigator.clipboard.writeText(reviewLink(feedbackId, radar ? `${pathname}${search}` : null)).then(markCopied, () => {})
  }
  const Icon = copied ? Check : Link2
  return (
    <button type="button" className="inline-flex items-center gap-1 link focus-ring rounded-sm" onClick={copy}>
      <Icon size={14} className="flex-shrink-0" aria-hidden="true" />
      {copied ? t('linkCopied') : t('copyLink')}
      <span className="sr-only" role="status">{copied ? t('linkCopied') : ''}</span>
    </button>
  )
}
