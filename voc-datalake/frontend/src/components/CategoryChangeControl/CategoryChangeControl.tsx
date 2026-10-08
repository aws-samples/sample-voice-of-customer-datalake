/**
 * @fileoverview "Change category" for one review, plus the badge that marks a
 * category a person set by hand.
 *
 * The picker offers only the categories the caller can see (config ∩ their
 * category scope) — the route refuses a target the caller cannot see, and also
 * one the item is not currently visible under, answering 404. Used on the
 * feedback detail page and on every full feedback card.
 *
 * @module components/CategoryChangeControl
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Check, Loader2, Tags, UserPen } from 'lucide-react'
import { format, isValid, parseISO } from 'date-fns'
import {
  categoryChangeErrorKey, invalidateAfterCategoryChange, setFeedbackCategory,
} from '../../api/feedbackCategoryApi'
import { useVisibleCategories } from '../../hooks/useCategories'
import type { FeedbackCategoryChange } from '../../api/feedbackCategoryApi'
import type { FeedbackItem } from '../../api/types'
import type { Category } from '../CategoriesManager/CategoriesManager'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

/** `category_source` of a hand-set category. */
const MANUAL_SOURCE = 'manual'

function formatWhen(at: string | undefined): string | null {
  if (at === undefined) return null
  const date = parseISO(at)
  return isValid(date) ? format(date, 'MMM d, yyyy') : null
}

/** "Changed manually by …" — rendered only for a hand-set category. */
export function ManualCategoryBadge({ feedback }: Readonly<{ feedback: Pick<FeedbackItem, 'category_source' | 'category_override'> }>) {
  const { t } = useTranslation('components')
  if (feedback.category_source !== MANUAL_SOURCE) return null
  const override = feedback.category_override
  const by = override?.by_username
  const when = formatWhen(override?.at)
  const previous = override?.previous_category
  const details = [
    previous === undefined || previous === '' ? null : t('categoryChange.previous', { category: previous }),
    when,
  ].filter((part): part is string => part !== null).join(' · ')
  return (
    <span className="badge badge-info" title={details === '' ? undefined : details}>
      <UserPen size={12} aria-hidden="true" />
      {by === undefined || by === '' ? t('categoryChange.manual') : t('categoryChange.manualBy', { user: by })}
    </span>
  )
}

function useCategoryChange(feedbackId: string, onDone: () => void) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (change: FeedbackCategoryChange) => setFeedbackCategory(feedbackId, change),
    onSuccess: () => {
      void invalidateAfterCategoryChange(queryClient)
      onDone()
    },
  })
}

interface Choice {
  category: string
  subcategory: string
}

/**
 * The picker's current choice. Derived from the user's pick rather than seeded
 * into state: the options may still be loading on the first render, and a
 * seeded value would freeze on '' for a perfectly valid item.
 */
function useCategoryChoice(feedback: FeedbackItem, categories: readonly Category[]) {
  const [picked, setPicked] = useState<Choice | null>(null)
  const original: Choice = { category: feedback.category, subcategory: feedback.subcategory ?? '' }
  const current = categories.some((c) => c.name === original.category) ? original.category : ''
  const choice: Choice = picked ?? { category: current, subcategory: original.subcategory }
  return {
    choice,
    subcategories: categories.find((c) => c.name === choice.category)?.subcategories ?? [],
    unchanged: choice.category === original.category && choice.subcategory === original.subcategory,
    // A new category resets the subcategory: the old one belongs to another parent.
    pickCategory: (category: string) => setPicked({ category, subcategory: '' }),
    pickSubcategory: (subcategory: string) => setPicked({ category: choice.category, subcategory }),
  }
}

function LabeledSelect({ label, value, onChange, disabled, children }: Readonly<{
  label: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  children: ReactNode
}>) {
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text-strong mb-1">{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled} className="select select-sm w-full">
        {children}
      </select>
    </div>
  )
}

function ChangeForm({ feedback, onClose }: Readonly<{ feedback: FeedbackItem; onClose: () => void }>) {
  const { t } = useTranslation('components')
  const { categories, isLoading } = useVisibleCategories()
  const { choice, subcategories, unchanged, pickCategory, pickSubcategory } = useCategoryChoice(feedback, categories)
  const change = useCategoryChange(feedback.feedback_id, onClose)

  if (isLoading) return <Loader2 size={14} className="animate-spin text-muted" aria-label={t('categoryChange.loading')} />

  const save = () => change.mutate({
    category: choice.category,
    ...(choice.subcategory === '' ? {} : { subcategory: choice.subcategory }),
  })

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-bg-accent p-2 sm:p-3">
      <div className="grid gap-2 sm:grid-cols-2">
        <LabeledSelect label={t('categoryChange.category')} value={choice.category} onChange={pickCategory}>
          <option value="" disabled>{t('categoryChange.choose')}</option>
          {categories.map((c) => <option key={c.id} value={c.name}>{c.description ?? c.name}</option>)}
        </LabeledSelect>
        <LabeledSelect
          label={t('categoryChange.subcategory')}
          value={choice.subcategory}
          onChange={pickSubcategory}
          disabled={subcategories.length === 0}
        >
          <option value="">{t('categoryChange.noSubcategory')}</option>
          {subcategories.map((s) => <option key={s.id} value={s.name}>{s.description ?? s.name}</option>)}
        </LabeledSelect>
      </div>
      {change.isError && (
        <p role="alert" className="text-xs text-danger flex items-center gap-1">
          <AlertCircle size={12} aria-hidden="true" /> {t(categoryChangeErrorKey(change.error))}
        </p>
      )}
      <StickyActionBar variant="inline" className="flex justify-end gap-2 py-2">
        <button type="button" onClick={onClose} className="btn btn-secondary btn-sm">{t('categoryChange.cancel')}</button>
        <button
          type="button"
          onClick={save}
          disabled={choice.category === '' || unchanged || change.isPending}
          className="btn btn-primary btn-sm"
        >
          {change.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          {t('categoryChange.save')}
        </button>
      </StickyActionBar>
    </div>
  )
}

/** The "Change category" trigger; expands into the picker in place. */
export default function CategoryChangeControl({ feedback }: Readonly<{ feedback: FeedbackItem }>) {
  const { t } = useTranslation('components')
  const [open, setOpen] = useState(false)
  if (open) return <ChangeForm feedback={feedback} onClose={() => setOpen(false)} />
  return (
    <button type="button" onClick={() => setOpen(true)} className="btn btn-ghost btn-sm">
      <Tags size={14} aria-hidden="true" />
      {t('categoryChange.open')}
    </button>
  )
}
