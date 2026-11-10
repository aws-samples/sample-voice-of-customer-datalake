/**
 * @fileoverview A review's dimension values, tags and — when its source
 * withholds personal data — the PII policy it was stored under.
 *
 * Dimension chips show the configured label of the dimension and value; a key
 * no longer configured still shows (by key), so nothing stored is hidden. A
 * hand-set value is marked by an icon and a title, not by a colour: every
 * dimension and tag is a descriptive label, so it is neutral (`badge-muted`,
 * docs/kiro-design-system.md › Labels vs status); only the PII policy badge is
 * a state and keeps its `warn` tone.
 *
 * @module components/FeedbackDimensions/FeedbackDimensionChips
 */
import { useTranslation } from 'react-i18next'
import { EyeOff, Hash, ShieldCheck, UserPen } from 'lucide-react'
import { useDimensionsConfig } from '../../hooks/useDimensions'
import { dimensionChips } from './feedbackDimensions'
import type { FeedbackItem } from '../../api/types'

type ChipFeedback = Pick<FeedbackItem, 'dimensions' | 'dimension_sources' | 'tags' | 'pii_policy'>

/**
 * The same state as a small note under the review text (the detail card): what was withheld,
 * said in a sentence where it applies, not a badge beside the edit buttons.
 */
export function PiiPolicyNote({ policy }: Readonly<{ policy: FeedbackItem['pii_policy'] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'feedbackDimensions' })
  if (policy !== 'redact' && policy !== 'summary_only') return null
  const Icon = policy === 'redact' ? ShieldCheck : EyeOff
  return (
    <p data-testid="pii-policy-note" className="mt-2 flex items-center gap-1 text-xs text-muted">
      <Icon size={12} aria-hidden="true" />
      {t(policy === 'redact' ? 'redactedHint' : 'summaryOnlyHint')}
    </p>
  )
}

/** "Redacted" / "Summary only" for a source that withholds personal data; nothing for allow. */
function PiiPolicyBadge({ policy }: Readonly<{ policy: FeedbackItem['pii_policy'] }>) {
  const { t } = useTranslation('components', { keyPrefix: 'feedbackDimensions' })
  if (policy === 'redact') {
    return <span className="badge badge-warn" title={t('redactedHint')}><ShieldCheck size={12} aria-hidden="true" />{t('redacted')}</span>
  }
  if (policy === 'summary_only') {
    return <span className="badge badge-warn" title={t('summaryOnlyHint')}><EyeOff size={12} aria-hidden="true" />{t('summaryOnly')}</span>
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
          <span key={chip.key} className="badge badge-muted" title={manual ? t('setByHand') : undefined}>
            {manual && <UserPen size={12} aria-label={t('setByHand')} />}
            {chip.label}: <span className="text-text">{chip.value}</span>
          </span>
        )
      })}
    </>
  )
}

/** `withPolicy` false where the policy is already said as a note on the text (the detail card). */
export default function FeedbackDimensionChips({ feedback, withPolicy = true }: Readonly<{ feedback: ChipFeedback; withPolicy?: boolean }>) {
  return (
    <>
      {withPolicy ? <PiiPolicyBadge policy={feedback.pii_policy} /> : null}
      {feedback.dimensions !== undefined && <DimensionChipList stored={feedback.dimensions} sources={feedback.dimension_sources} />}
      {(feedback.tags ?? []).map((tag) => (
        <span key={tag} className="badge badge-muted">
          <Hash size={12} aria-hidden="true" />{tag}
        </span>
      ))}
    </>
  )
}
