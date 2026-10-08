/**
 * @fileoverview A review's dimension values, tags and — when its source
 * withholds personal data — the PII policy it was stored under.
 *
 * Dimension chips show the configured label of the dimension and value; a key
 * no longer configured still shows (by key), so nothing stored is hidden. A
 * hand-set value is marked.
 *
 * @module components/FeedbackDimensions/FeedbackDimensionChips
 */
import { useTranslation } from 'react-i18next'
import { EyeOff, Hash, ShieldCheck, UserPen } from 'lucide-react'
import { useDimensionsConfig } from '../../hooks/useDimensions'
import { dimensionChips } from './feedbackDimensions'
import type { FeedbackItem } from '../../api/types'

type ChipFeedback = Pick<FeedbackItem, 'dimensions' | 'dimension_sources' | 'tags' | 'pii_policy'>

/** "Redacted" / "Summary only" for a source that withholds personal data; nothing for allow. */
function PiiPolicyBadge({ policy }: Readonly<{ policy: FeedbackItem['pii_policy'] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'feedbackDimensions' })
  if (policy === 'redact') {
    return <span className="badge badge-warn text-xs" title={t('redactedHint')}><ShieldCheck size={12} aria-hidden="true" />{t('redacted')}</span>
  }
  if (policy === 'summary_only') {
    return <span className="badge badge-warn text-xs" title={t('summaryOnlyHint')}><EyeOff size={12} aria-hidden="true" />{t('summaryOnly')}</span>
  }
  return null
}

/** The dimension chips; only mounted for a review that has dimensions, so it alone reads the config. */
function DimensionChipList({ stored, sources }: Readonly<{ stored: Readonly<Record<string, string>>; sources: ChipFeedback['dimension_sources'] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'feedbackDimensions' })
  const { data } = useDimensionsConfig()
  return (
    <>
      {dimensionChips(data?.dimensions ?? [], stored).map((chip) => {
        const manual = sources?.[chip.key] === 'manual'
        return (
          <span key={chip.key} className="badge badge-info text-xs" title={manual ? t('setByHand') : undefined}>
            {manual && <UserPen size={12} aria-label={t('setByHand')} />}
            <span className="text-muted">{chip.label}:</span> {chip.value}
          </span>
        )
      })}
    </>
  )
}

export default function FeedbackDimensionChips({ feedback }: Readonly<{ feedback: ChipFeedback }>) {
  return (
    <>
      <PiiPolicyBadge policy={feedback.pii_policy} />
      {feedback.dimensions !== undefined && <DimensionChipList stored={feedback.dimensions} sources={feedback.dimension_sources} />}
      {(feedback.tags ?? []).map((tag) => (
        <span key={tag} className="badge badge-muted text-xs">
          <Hash size={12} aria-hidden="true" />{tag}
        </span>
      ))}
    </>
  )
}
