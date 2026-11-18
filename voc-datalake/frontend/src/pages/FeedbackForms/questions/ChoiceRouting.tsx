/**
 * @fileoverview The choice editor's Routing view (UX §4.1): per option (and the Other row), the category its answer
 * files feedback under (by name; "— Form default" when none) and where it goes next. A "Go to" writes the option's
 * own rule (single `equals`, multiple `includes_any [code]`); an option a broader rule in Logic names shows
 * "Set by a rule in Logic" instead.
 *
 * @module pages/FeedbackForms/questions/ChoiceRouting
 */
import { useTranslation } from 'react-i18next'
import { z } from 'zod'
import type { Category } from '../../../components/CategoriesManager/CategoriesManager'
import { categoryLabel, subcategoryLabel } from '../../../utils/displayLabels'
import type { ChoiceQuestion, FormV2, OptionCategory } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { splitOtherwise } from '../model/rules'
import { targetText } from '../logic/ruleSentence'
import { optionJump, withOptionJump } from './choiceOps'

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
    <div className="space-y-2">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-[13px]">
          <thead>
            <tr className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">
              <th scope="col" className="py-1 pr-2">{t('choice.routing.option')}</th>
              <th scope="col" className="py-1 pr-2">{t('choice.routing.category')}</th>
              <th scope="col" className="py-1">{t('choice.routing.goTo')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.code}>
                <th scope="row" className="py-1.5 pr-2 font-normal text-text">{row.label}</th>
                <td className="py-1.5 pr-2">
                  {row.isOther ? <span className="text-[12px] text-muted">{t('choice.routing.formDefault')}</span>
                    : <CategorySelect value={row.category} categories={categories} label={t('choice.routing.categoryOf', { option: row.label })} onChange={(next) => setCategory(row.code, next)} />}
                </td>
                <td className="py-1.5">
                  <GoToSelect form={form} question={question} index={index} code={row.code} label={t('choice.routing.goToOf', { option: row.label })}
                    onChange={onChange} onEditLogic={onEditLogic} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[12px] text-muted">{t('choice.routing.precedence')}</p>
      {question.type === 'multi_select' && <p className="text-[12px] text-muted">{t('choice.routing.firstRuleWins')}</p>}
    </div>
  )
}
