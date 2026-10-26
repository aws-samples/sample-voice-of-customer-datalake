/**
 * @fileoverview "Tags & filters" chips on a review's detail card. The category, subcategory and
 * source chips deep-link into the consolidated Categories page (issue #198), which reads these
 * params via useCategoryFilters.
 * @module pages/FeedbackDetail/FeedbackTags
 */
import { Flame, Tag, Users } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import type { FeedbackItem } from '../../api/types'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { humanizeId } from '../../utils/displayLabels'
import { SECTION_LABEL } from './FeedbackDetailParts'

/**
 * Tones follow the labels-vs-status rule: the category is the one emphasised chip (accent);
 * subcategory, source, persona and journey stage are neutral; Urgent keeps its `warn` state
 * tone. Clickable chips share one neutral recipe so hue never tells them apart.
 */
const CHIP = 'px-3 py-1.5 rounded-full text-xs sm:text-sm font-medium'
const FILTER_CHIP = `${CHIP} focus-ring transition-colors cursor-pointer active:scale-95`
const LABEL_CHIP = `${CHIP} bg-bg-hover text-muted flex items-center gap-1`

/** The Categories deep link a chip opens: its filter params, nothing else. */
function categoriesLinkFor(params: Readonly<Record<string, string>>): string {
  return `/categories?${new URLSearchParams(params).toString()}`
}

/**
 * A subcategory chip filters by the subcategory (inside its category), never a
 * free-text search for the raw id (`?q=support_quality` matched nothing).
 */
function subcategoryLinkFor(category: string, subcategory: string): string {
  return categoriesLinkFor({ category, subcategory })
}

/** A clickable filter chip; `emphasised` is the row's one accent (the category). */
function FilterChip({ emphasised = false, onClick, children }: Readonly<{ emphasised?: boolean; onClick: () => void; children: ReactNode }>) {
  const tone = emphasised
    ? 'bg-accent-subtle text-accent-text hover:bg-accent/25'
    : 'bg-bg-hover text-text border border-border hover:border-border-strong'
  return <button type="button" onClick={onClick} className={`${FILTER_CHIP} ${tone}`}>{children}</button>
}

interface TagsSectionProps {
  readonly feedback: FeedbackItem
  readonly onOpen: (path: string) => void
}

export default function TagsSection({ feedback, onOpen }: TagsSectionProps) {
  const { t } = useTranslation('feedbackDetail')
  const labels = useDisplayLabels()
  return (
    <div className="mb-4 sm:mb-6">
      <h2 className={`${SECTION_LABEL} flex items-center gap-2`}>
        <Tag size={14} aria-hidden="true" />
        {t('tagsAndFilters')}
      </h2>
      <div className="flex flex-wrap gap-1.5 sm:gap-2">
        <FilterChip emphasised onClick={() => onOpen(categoriesLinkFor({ category: feedback.category }))}>{labels.category(feedback.category)}</FilterChip>
        {feedback.subcategory && (
          <FilterChip onClick={() => onOpen(subcategoryLinkFor(feedback.category, feedback.subcategory ?? ''))}>{labels.subcategory(feedback.subcategory, feedback.category)}</FilterChip>
        )}
        <FilterChip onClick={() => onOpen(categoriesLinkFor({ source: feedback.source_platform }))}>{labels.source(feedback.source_platform)}</FilterChip>
        {feedback.persona_name && (
          <span className={LABEL_CHIP}>
            <Users size={12} aria-hidden="true" />
            {feedback.persona_name}
          </span>
        )}
        {feedback.journey_stage && (
          <span className={LABEL_CHIP}>
            {humanizeId(feedback.journey_stage)}
          </span>
        )}
        {feedback.urgency === 'high' && (
          <span className={`${CHIP} inline-flex items-center gap-1 bg-warn-subtle text-warn`}>
            <Flame size={14} aria-hidden="true" />{t('urgent')}
          </span>
        )}
      </div>
    </div>
  )
}
