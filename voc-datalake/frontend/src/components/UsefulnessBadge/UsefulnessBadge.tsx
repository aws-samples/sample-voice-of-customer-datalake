/**
 * @fileoverview A review's usefulness band as a badge: "High usefulness" / "Medium" / "Low".
 *
 * The band is the server's heuristic (`shared/usefulness.py`): how much a reader can learn from
 * the review. A review not scored yet shows nothing (no "Unrated" badge on every old review).
 * The visible text is short; the accessible name always says what the badge measures.
 * Ported from PR #429's `EnrichmentBadges` (@aws-bryan), main's band instead of his score.
 *
 * @module components/UsefulnessBadge
 */
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import { isUsefulnessBand } from '../../api/feedbackFacets'
import type { UsefulnessBand } from '../../api/feedbackFacets'

const TONE: Readonly<Record<UsefulnessBand, string>> = {
  high: 'badge-ok',
  medium: 'badge-info',
  low: 'badge-muted',
}

export default function UsefulnessBadge({ band }: Readonly<{ band: unknown }>) {
  const { t } = useTranslation('components')
  if (!isUsefulnessBand(band)) return null
  const label = t('facetFilters.usefulnessBadge', { band: t(`facetFilters.usefulnessShort.${band}`) })
  return (
    <span className={clsx('badge', TONE[band])} title={label} data-testid="usefulness-badge">
      <span aria-hidden="true">{t(`facetFilters.usefulnessShort.${band}`)}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}
