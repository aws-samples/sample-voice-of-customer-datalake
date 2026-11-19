/**
 * @fileoverview The choice editor's Routing view (UX §4.1): per option (and the Other row), the category its answer
 * files feedback under (by name; "— Form default" when none) and where it goes next. A "Go to" writes the option's
 * own rule (single `equals`, multiple `includes_any [code]`); an option a broader rule in Logic names shows
 * "Set by a rule in Logic" instead.
 *
 * The rows follow the editor column's width (a container query, not the viewport's): from 40rem (640 px) one row per
 * option, Option · Category · Go to under column headings; narrower, each option stacks, its label on its own line
 * and then Category and Go to side by side, each with its caption (a phone's column, under 28rem, puts them one under
 * the other), so a long target wraps to two lines at most (the customizable select cannot cut its text with an
 * ellipsis). Every select is named after its option ("Category for “Too expensive”"), so the headings and captions
 * are only visual.
 *
 * @module pages/FeedbackForms/questions/ChoiceRouting
 */
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { z } from 'zod'
import type { Category } from '../../../components/CategoriesManager/CategoriesManager'
import { categoryLabel, subcategoryLabel } from '../../../utils/displayLabels'
import type { ChoiceQuestion, FormV2, OptionCategory } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { splitOtherwise } from '../model/rules'
import { targetText } from '../logic/ruleSentence'
import { optionJump, withOptionJump } from './choiceOps'

/** From a 40rem editor column: Option · Category · Go to on one row (the headings use the same columns). */
const ROW_GRID = '@[40rem]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.2fr)] @[40rem]:items-center'

/** A Category or Go to cell: its caption above the control while the rows are stacked (the headings name it after). */
function RoutingCell({ caption, children }: Readonly<{ caption: string; children: ReactNode }>) {
  return (
    <div className="min-w-0">
      <span aria-hidden="true" className="mb-0.5 block text-[12px] text-muted @[40rem]:hidden">{caption}</span>
      {children}
    </div>
  )
}

const NO_CATEGORY = ''
const categoryValue = (category: OptionCategory): string => JSON.stringify([category.category, category.subcategory ?? ''])

const categoryPair = z.tuple([z.string().min(1), z.string()])

function parseCategory(value: string): OptionCategory | undefined {
  if (value === NO_CATEGORY) return undefined
  const parsed = categoryPair.safeParse(JSON.parse(value))
  if (!parsed.success) return undefined
  const [category, subcategory] = parsed.data
  return subcategory === '' ? { category } : { category, subcategory }
}

function CategorySelect({ value, categories, label, onChange }: Readonly<{
  value: OptionCategory | undefined; categories: readonly Category[]; label: string; onChange: (value: OptionCategory | undefined) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const entries = categories.flatMap((category) => [
    { value: categoryValue({ category: category.name }), label: categoryLabel(category.name, categories) },
    ...category.subcategories.map((sub) => ({
      value: categoryValue({ category: category.name, subcategory: sub.name }),
      label: `${categoryLabel(category.name, categories)} › ${subcategoryLabel(sub.name, category.name, categories)}`,
    })),
  ])
  const current = value === undefined ? NO_CATEGORY : categoryValue(value)
  const unknown = value !== undefined && !entries.some((entry) => entry.value === current)
  return (
    <select className="select select-sm" aria-label={label} value={current} onChange={(event) => onChange(parseCategory(event.target.value))}>
      <option value={NO_CATEGORY}>{t('choice.routing.formDefault')}</option>
      {unknown && <option value={current}>{t('choice.routing.notConfigured', { name: [value.category, value.subcategory].filter((part) => part !== undefined).join(' › ') })}</option>}
      {entries.map((entry) => <option key={entry.value} value={entry.value}>{entry.label}</option>)}
    </select>
  )
}

function GoToSelect({ form, question, index, code, label, onChange, onEditLogic }: Readonly<{
  form: FormV2; question: ChoiceQuestion; index: number; code: string; label: string
  onChange: (question: ChoiceQuestion) => void; onEditLogic: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const jump = optionJump(question, code)
  if (jump.kind === 'broader') {
    return (
      <span className="inline-flex flex-wrap items-center gap-1 text-[12px] text-muted">
        {t('choice.routing.setByRule')}
        <button type="button" className="btn btn-ghost btn-sm" onClick={onEditLogic}>{t('choice.routing.editInLogic')}</button>
      </span>
    )
  }
  const { otherwise } = splitOtherwise(question)
  const fallback = otherwise === null ? t('logic.target.next') : t('choice.routing.otherwise', { target: targetText(t, form, otherwise) })
  return (
    <select className="select select-sm" aria-label={label} value={jump.kind === 'own' ? jump.target : ''}
      onChange={(event) => onChange(withOptionJump(question, code, event.target.value === '' ? null : event.target.value))}>
      <option value="">{fallback}</option>
      {form.questions.slice(index + 1).map((later, offset) => (
        <option key={later.id} value={later.id}>{t('logic.target.question', { number: index + offset + 2, headline: textIn(later.headline, form.language) })}</option>
      ))}
      {form.endings.map((ending) => <option key={ending.id} value={ending.id}>{t('logic.target.ending', { title: textIn(ending.title, form.language) })}</option>)}
    </select>
  )
}

export default function ChoiceRouting({ form, question, index, categories, onChange, onEditLogic }: Readonly<{
  form: FormV2
  question: ChoiceQuestion
  /** The question's position in the form (later questions are the jump targets). */
  index: number
  categories: readonly Category[]
  onChange: (question: ChoiceQuestion) => void
  onEditLogic: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const rows = [
    ...question.options.map((option, at) => ({ code: option.code, label: textIn(option.label, form.language) || t('choice.optionN', { number: at + 1 }), category: option.category, isOther: false })),
    ...(question.other.enabled ? [{ code: 'other', label: t('choice.routing.otherRow', { label: textIn(question.other.label, form.language) || t('choice.otherDefault') }), category: undefined, isOther: true }] : []),
  ]
  const setCategory = (code: string, category: OptionCategory | undefined) =>
    onChange({ ...question, options: question.options.map((option) => (option.code === code ? { ...option, category } : option)) })
  return (
    <div className="@container space-y-2">
      <div aria-hidden="true" className={clsx('hidden @[40rem]:grid', ROW_GRID, 'text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong')}>
        <span>{t('choice.routing.option')}</span><span>{t('choice.routing.category')}</span><span>{t('choice.routing.goTo')}</span>
      </div>
      <ul aria-label={t('choice.routing.title')} className="divide-y divide-border text-[13px]">
        {rows.map((row) => (
          <li key={row.code} className={clsx('grid grid-cols-1 gap-x-2 gap-y-1 py-2 @[28rem]:grid-cols-2 @[40rem]:py-1.5', ROW_GRID)}>
            <span className="min-w-0 break-words font-medium text-text @[28rem]:col-span-2 @[40rem]:col-span-1 @[40rem]:font-normal">{row.label}</span>
            <RoutingCell caption={t('choice.routing.category')}>
              {row.isOther ? <span className="text-[12px] text-muted">{t('choice.routing.formDefault')}</span>
                : <CategorySelect value={row.category} categories={categories} label={t('choice.routing.categoryOf', { option: row.label })} onChange={(next) => setCategory(row.code, next)} />}
            </RoutingCell>
            <RoutingCell caption={t('choice.routing.goTo')}>
              <GoToSelect form={form} question={question} index={index} code={row.code} label={t('choice.routing.goToOf', { option: row.label })}
                onChange={onChange} onEditLogic={onEditLogic} />
            </RoutingCell>
          </li>
        ))}
      </ul>
      <p className="text-[12px] text-muted">{t('choice.routing.precedence')}</p>
      {question.type === 'multi_select' && <p className="text-[12px] text-muted">{t('choice.routing.firstRuleWins')}</p>}
    </div>
  )
}
