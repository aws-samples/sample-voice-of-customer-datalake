/**
 * @fileoverview The `save_categories` card (docs/categories.md "Proposed by the assistant"): the categories the
 * assistant proposed, editable before Approve. Each category's label (what every screen shows; its stored name is
 * shown under it), its product or area, and its subcategories, which the person may rename, add (up to the limit) or
 * remove; a category may be left out. It reads the categories configured now (the current workspace's, with the
 * person's own session) and says what Approve does: add these after them, never change one.
 *
 * Approve is held while the stored categories are not read, or while a field is not right (each says why); what the
 * card shows when it is approved is what the executor saves (shown.ts `categories`).
 *
 * @module assistant/approvals/previews/CategoriesPreview
 */
import { useContext, useEffect, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { CATEGORY_PROPOSAL_LIMITS, categorySlug, foldedLabel } from '@stream/assistant/tools/client/category-schemas'
import { LabeledField } from '../../../components/LabeledField/LabeledField'
import { useCurrentWorkspace } from '../../../workspace/currentWorkspace'
import { CATEGORIES_PREVIEW_KEY, readStoredCategories } from '../categoryExecutors'
import { categoriesFingerprint, checkedDraft, draftOf } from '../categorySchemas'
import { ApprovalHoldContext, ShownContext, recordCategories } from '../shown'
import { CardNote } from './FieldDiff'
import type { CategoryDraft, DraftProblem, SaveCategoriesArgs } from '../categorySchemas'

const K = 'preview.saveCategories'

type Problems = ReadonlyMap<string, DraftProblem>
type Change = (index: number, next: CategoryDraft | null) => void

/** `entries` with the one at `index` replaced by `next`, or left out when `next` is null. */
function replaced<T>(entries: readonly T[], index: number, next: T | null): T[] {
  const kept = entries.filter((_entry, at) => at !== index || next !== null)
  return next === null ? kept : entries.map((entry, at) => (at === index ? next : entry))
}

function Notice({ text }: Readonly<{ text: string }>) {
  return <p role="alert" className="rounded-md border border-warn/30 bg-warn-subtle p-2 text-[12px] text-text">{text}</p>
}

/** The field's hint: what is wrong with it, else `fallback`. */
function useHint(problems: Problems, path: string, fallback?: string) {
  const { t } = useTranslation('assistantTools')
  const problem = problems.get(path)
  return problem === undefined
    ? { hint: fallback, hintTone: 'muted' as const, invalid: false }
    : { hint: t(`${K}.problems.${problem}`), hintTone: 'danger' as const, invalid: true }
}

function SubcategoryRow({ value, index, path, problems, onChange, onRemove }: Readonly<{
  value: string; index: number; path: string; problems: Problems
  onChange: (value: string) => void; onRemove: () => void
}>) {
  const { t } = useTranslation('assistantTools')
  const { hint, invalid } = useHint(problems, path)
  const name = t(`${K}.subcategoryField`, { number: index + 1 })
  return (
    <li className="space-y-0.5">
      <div className="flex items-center gap-1">
        <input className="input w-full" value={value} aria-label={name} aria-invalid={invalid}
          onChange={(event) => onChange(event.target.value)} />
        <button type="button" className="icon-btn" aria-label={t(`${K}.removeSubcategory`, { label: value === '' ? name : value })}
          onClick={onRemove}>
          <X size={14} aria-hidden="true" />
        </button>
      </div>
      {hint !== undefined && <p className="text-[12px] text-danger">{hint}</p>}
    </li>
  )
}

function Subcategories({ category, index, problems, onChange }: Readonly<{
  category: CategoryDraft; index: number; problems: Problems; onChange: (subcategories: string[]) => void
}>) {
  const { t } = useTranslation('assistantTools')
  const subs = category.subcategories
  const replace = (at: number, value: string | null) => onChange(replaced(subs, at, value))
  return (
    <div className="space-y-1">
      <p className="text-[12px] font-medium text-muted">{t(`${K}.subcategories`)}</p>
      <ul className="space-y-1">
        {subs.map((sub, at) => (
          <SubcategoryRow key={at} value={sub} index={at} path={`categories.${String(index)}.subcategories.${String(at)}`}
            problems={problems} onChange={(value) => replace(at, value)} onRemove={() => replace(at, null)} />
        ))}
      </ul>
      <button type="button" className="btn btn-ghost btn-sm" disabled={subs.length >= CATEGORY_PROPOSAL_LIMITS.maxSubcategories}
        onClick={() => onChange([...subs, ''])}>
        <Plus size={14} aria-hidden="true" /> {t(`${K}.addSubcategory`)}
      </button>
    </div>
  )
}

function CategoryEditor({ category, index, problems, removable, onChange }: Readonly<{
  category: CategoryDraft; index: number; problems: Problems; removable: boolean; onChange: Change
}>) {
  const { t } = useTranslation('assistantTools')
  const path = `categories.${String(index)}`
  const slug = categorySlug(foldedLabel(category.label))
  const label = useHint(problems, `${path}.label`, slug === '' ? undefined : t(`${K}.storedAs`, { name: slug }))
  const product = useHint(problems, `${path}.product`)
  const title = t(`${K}.category`, { number: index + 1 })
  return (
    <fieldset className="space-y-2 rounded-md border border-border p-2" data-testid={`category-${String(index)}`}>
      <legend className="px-1 text-[12px] font-semibold text-text-strong">{title}</legend>
      <LabeledField label={t(`${K}.labelField`)} hint={label.hint} hintTone={label.hintTone}>
        {(id) => (
          <input id={id} className="input w-full" value={category.label} aria-invalid={label.invalid}
            aria-describedby={label.hint === undefined ? undefined : `${id}-hint`}
            onChange={(event) => onChange(index, { ...category, label: event.target.value })} />
        )}
      </LabeledField>
      <LabeledField label={t(`${K}.productField`)} hint={product.hint} hintTone={product.hintTone}>
        {(id) => (
          <input id={id} className="input w-full" value={category.product} aria-invalid={product.invalid}
            onChange={(event) => onChange(index, { ...category, product: event.target.value })} />
        )}
      </LabeledField>
      <Subcategories category={category} index={index} problems={problems}
        onChange={(subcategories) => onChange(index, { ...category, subcategories })} />
      {removable && (
        <button type="button" className="btn btn-ghost btn-sm text-danger"
          onClick={() => onChange(index, null)}>
          <X size={14} aria-hidden="true" /> {t(`${K}.removeCategory`, { label: category.label === '' ? title : category.label })}
        </button>
      )}
    </fieldset>
  )
}

export function CategoriesPreview({ args }: Readonly<{ args: SaveCategoriesArgs }>) {
  const { t } = useTranslation('assistantTools')
  const shown = useContext(ShownContext)
  const hold = useContext(ApprovalHoldContext)
  const inWorkspace = useCurrentWorkspace() !== null
  const stored = useQuery({ queryKey: CATEGORIES_PREVIEW_KEY, queryFn: readStoredCategories, retry: false, staleTime: 0 })
  const [draft, setDraft] = useState<CategoryDraft[]>(() => draftOf(args))
  const checked = useMemo(() => (stored.data === undefined ? undefined : checkedDraft(draft, stored.data)), [draft, stored.data])

  // What Approve saves, recorded as the card shows it (the executor adds exactly this set, or nothing).
  useEffect(() => {
    const what = stored.data !== undefined && checked?.ok === true
      ? { base: categoriesFingerprint(stored.data), set: checked.set } : undefined
    if (shown !== null) recordCategories(shown, what)
    hold(what === undefined)
  }, [shown, hold, stored.data, checked])

  if (stored.isError) return <Notice text={t(`${K}.readFailed`)} />
  if (stored.data === undefined) return <p role="status" className="text-[12px] text-muted">{t(`${K}.reading`)}</p>
  const problems: Problems = checked?.ok === false ? checked.problems : new Map()
  const change: Change = (index, next) => setDraft((current) => replaced(current, index, next))
  return (
    <div className="space-y-2" aria-label={t(`${K}.label`)} role="group">
      <p className="text-[12px] text-muted">{stored.data.length === 0
        ? t(`${K}.noneConfigured`) : t(`${K}.someConfigured`, { number: stored.data.length })}</p>
      {draft.map((category, index) => (
        // (its position is a draft category's identity: it has no id until it is saved)
        <CategoryEditor key={index} category={category} index={index} problems={problems}
          removable={draft.length > 1} onChange={change} />
      ))}
      {problems.size > 0 && <Notice text={t(`${K}.fixFirst`)} />}
      <CardNote text={inWorkspace ? t(`${K}.intoWorkspace`) : t(`${K}.intoDeployment`)} />
    </div>
  )
}
