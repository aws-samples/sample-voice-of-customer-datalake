/**
 * @fileoverview The reviews behind a brief card, each a link that opens it in the shared review
 * modal on Home (`ReviewLink`, `?review=`). Replaces a bare count nobody could act on. At most
 * MAX_LINKS links; the rest are counted ("and 4 more").
 * @module pages/Home/brief/EvidenceLinks
 */
import { useTranslation } from 'react-i18next'
import ReviewLink from '../../../components/ReviewLink/ReviewLink'

const MAX_LINKS = 5

interface EvidenceLinksProps {
  readonly feedbackIds: readonly string[]
  /** A Radar card's brand key: its reviews open as Radar reviews. */
  readonly brand?: string
}

export default function EvidenceLinks({ feedbackIds, brand }: Readonly<EvidenceLinksProps>) {
  const { t } = useTranslation('briefing')
  const ids = [...new Set(feedbackIds)]
  if (ids.length === 0) return null
  const shown = ids.slice(0, MAX_LINKS)
  const more = ids.length - shown.length
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted">
      <span>{t('cards.evidence', { count: ids.length })}</span>
      <ul className="flex flex-wrap gap-x-3 gap-y-1">
        {shown.map((id, index) => (
          <li key={id}>
            <ReviewLink feedbackId={id} brand={brand} className="link text-sm"
              aria-label={t('cards.openReview', { n: index + 1, count: ids.length })}>
              {t('cards.reviewN', { n: index + 1 })}
            </ReviewLink>
          </li>
        ))}
      </ul>
      {more > 0 ? <span>{t('cards.moreReviews', { count: more })}</span> : null}
    </div>
  )
}
