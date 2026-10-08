/**
 * @fileoverview `set_feedback_category` — the review being changed, and its
 * category / subcategory before and after.
 *
 * Reads the item through the same query the Feedback Detail page uses, so an
 * open detail page and the card share one cache entry. Warns when the proposed
 * category is not one the user can see — the route would refuse it.
 *
 * @module assistant/approvals/previews/FeedbackCategoryPreview
 */
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { api } from '../../../api/client'
import { useVisibleCategories } from '../../../hooks/useCategories'
import { FieldChanges } from './FieldChangesPreview'
import type { SetFeedbackCategoryArgs } from '../schemas'

/** Characters of the review text shown on the card. */
const EXCERPT_CHARS = 200

function excerpt(text: string): string {
  return text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text
}

export function FeedbackCategoryPreview({ args }: Readonly<{ args: SetFeedbackCategoryArgs }>) {
  const { t } = useTranslation('assistantTools')
  const { data: feedback, isLoading } = useQuery({
    queryKey: ['feedback', args.feedback_id],
    queryFn: () => api.getFeedbackById(args.feedback_id),
    retry: false,
  })
  const { categories, isLoading: categoriesLoading } = useVisibleCategories()
  const unknownTarget = !categoriesLoading && !categories.some((c) => c.name === args.category)
  const updates = { category: args.category, subcategory: args.subcategory ?? '' }
  const current = feedback === undefined ? undefined : { category: feedback.category, subcategory: feedback.subcategory ?? '' }

  return (
    <div className="space-y-2">
      {feedback !== undefined && feedback.original_text !== '' && (
        <blockquote className="border-l-2 border-border pl-2 text-sm text-text">{excerpt(feedback.original_text)}</blockquote>
      )}
      <FieldChanges updates={updates} current={current} isLoading={isLoading} />
      {unknownTarget && <p className="text-[12px] text-warn">{t('preview.unknownCategory', { category: args.category })}</p>}
    </div>
  )
}
