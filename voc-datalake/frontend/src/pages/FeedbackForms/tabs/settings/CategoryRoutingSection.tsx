/**
 * @fileoverview Settings › Category routing (UX §14.1): the form's own category and subcategory (the fallback, with
 * the line every response is filed under), the per-option routing of each choice question with a way into its
 * Routing view, the precedence in one sentence, and the dimension defaults and tags every response carries.
 *
 * A form stores the category NAME (what the processor copies onto each response); a form saved with a config id
 * still resolves, and the next save stores the name. A name no longer configured is kept, never dropped, and said as
 * a state beside the select ("No longer configured", warn, "Pick a configured category").
 *
 * @module pages/FeedbackForms/tabs/settings/CategoryRoutingSection
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { AlertTriangle } from 'lucide-react'
import DimensionDefaultsSection from '../../../../components/DimensionFields/DimensionDefaultsSection'
import { useCategoriesConfig } from '../../../../hooks/useCategories'
import { categoryLabel, subcategoryLabel } from '../../../../utils/displayLabels'
import type { Category } from '../../../../components/CategoriesManager/CategoriesManager'
import { useDraft } from '../../builder/formDraftContext'
import { useBuilderUi } from '../../builder/builderUi'
import { isChoice } from '../../model/formsV2'
import { headlineShown } from '../../model/recall'

/** The entry a stored routing value names: by name, else (forms saved before) by config id. */
function findRouted<T extends { readonly id: string; readonly name: string }>(entries: readonly T[] | undefined, stored: string): T | undefined {
  if (stored === '' || entries === undefined) return undefined
  return entries.find((entry) => entry.name === stored) ?? entries.find((entry) => entry.id === stored)
}

/** A stored category the workspace no longer configures: a state, said beside the select (not inside an option). */
function NotConfigured({ id }: Readonly<{ id: string }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <p id={id} className="mt-1 flex flex-wrap items-center gap-2 text-[12px] text-text">
      <span className="badge badge-warn inline-flex items-center gap-1"><AlertTriangle size={12} aria-hidden="true" />{t('settings.routing.notConfiguredBadge')}</span>
      {t('settings.routing.pickConfigured')}
    </p>
  )
}

/** The form's category: the configured ones, and a stored name no longer among them (kept, and said as a state). */
function CategorySelect({ id, categories, category, configured, loaded }: Readonly<{
  id: string
  categories: readonly Category[]
  category: string
  /** The stored category is one the workspace configures. */
  configured: boolean
  /** The categories were read (before then every stored name would look "no longer configured"). */
  loaded: boolean
}>) {
  const { t } = useTranslation('feedbackForms')
  const { update } = useDraft()
  const kept = category !== '' && !configured
  const stale = loaded && kept
  return (
    <div>
      <label htmlFor={`${id}-category`} className="mb-1 block text-sm font-medium text-text">{t('settings.routing.category')}</label>
      <select id={`${id}-category`} className={clsx('select', stale && 'border-warn')} value={category}
        aria-describedby={stale ? `${id}-stale ${id}-hint` : `${id}-hint`}
        onChange={(event) => update((current) => ({ ...current, category: event.target.value, subcategory: '' }))}>
        <option value="">{t('settings.routing.none')}</option>
        {categories.map((entry) => <option key={entry.id} value={entry.name}>{categoryLabel(entry.name, categories)}</option>)}
        {kept && <option value={category}>{category}</option>}
      </select>
      {stale && <NotConfigured id={`${id}-stale`} />}
      <p id={`${id}-hint`} className="mt-1 text-[12px] text-muted">{t('settings.routing.categoryHint')}</p>
    </div>
  )
}

function FormCategory({ categories, loaded }: Readonly<{ categories: readonly Category[]; loaded: boolean }>) {
  const { t } = useTranslation('feedbackForms')
  const { form, update } = useDraft()
  const id = useId()
  const selected = findRouted(categories, form.category)
  const selectedSub = findRouted(selected?.subcategories, form.subcategory)
  const category = selected?.name ?? form.category
  const subcategory = selectedSub?.name ?? form.subcategory
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <CategorySelect id={id} categories={categories} category={category} configured={selected !== undefined} loaded={loaded} />
        <div>
          <label htmlFor={`${id}-subcategory`} className="mb-1 block text-sm font-medium text-text">{t('settings.routing.subcategory')}</label>
          <select id={`${id}-subcategory`} className="select" value={subcategory} disabled={selected === undefined}
            onChange={(event) => update((current) => ({ ...current, subcategory: event.target.value }))}>
            <option value="">{t('settings.routing.noSubcategory')}</option>
            {selected?.subcategories.map((sub) => <option key={sub.id} value={sub.name}>{subcategoryLabel(sub.name, selected.name, categories)}</option>)}
          </select>
        </div>
      </div>
      {category !== '' && (
        <p className="rounded-lg border border-border bg-bg-accent p-3 text-sm text-text">
          {t('settings.routing.taggedAs')}{' '}
          <code className="font-mono text-[12px]">category: &quot;{category}&quot;{subcategory !== '' && <>, subcategory: &quot;{subcategory}&quot;</>}</code>
        </p>
      )}
    </div>
  )
}

function OptionRouting() {
  const { t } = useTranslation('feedbackForms')
  const { form } = useDraft()
  const { go } = useBuilderUi()
  const choices = form.questions.map((question, index) => ({ question, number: index + 1 })).filter(({ question }) => isChoice(question))
  if (choices.length === 0) return <p className="text-sm text-muted">{t('settings.routing.noChoices')}</p>
  return (
    <ul className="divide-y divide-border rounded-lg border border-border" aria-label={t('settings.routing.perOption')}>
      {choices.map(({ question, number }) => {
        const options = isChoice(question) ? question.options : []
        const mapped = options.filter((option) => option.category !== undefined).length
        return (
          <li key={question.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1 text-text">{number} · {headlineShown(question, form.language)}</span>
            <span className="text-[12px] text-muted">{t('settings.routing.mapped', { mapped, count: options.length })}</span>
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => go('questions', [question.id])}
              aria-label={t('settings.routing.editQuestion', { number })}>{t('settings.routing.edit')}</button>
          </li>
        )
      })}
    </ul>
  )
}

export default function CategoryRoutingSection() {
  const { t } = useTranslation('feedbackForms')
  const { form, update } = useDraft()
  const { data } = useCategoriesConfig()
  const categories = data?.categories ?? []
  return (
    <div className="space-y-5">
      <FormCategory categories={categories} loaded={data !== undefined} />
      <div className="space-y-2">
        <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t('settings.routing.perOption')}</h3>
        <OptionRouting />
        <p className="text-[12px] text-muted">{t('settings.routing.precedence')}</p>
      </div>
      <DimensionDefaultsSection dimensionDefaults={form.dimension_defaults} tags={form.tags}
        hint={t('settings.routing.dimensionsHint')}
        onChange={(patch) => update((current) => ({
          ...current,
          ...(patch.dimension_defaults === undefined ? {} : { dimension_defaults: patch.dimension_defaults }),
          ...(patch.tags === undefined ? {} : { tags: patch.tags }),
        }))} />
    </div>
  )
}
