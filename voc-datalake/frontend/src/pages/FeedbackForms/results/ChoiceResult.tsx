/**
 * @fileoverview A choice question's results (UX §10.2): a bar per option in the editor's order (or by count), its
 * count and share of those who answered; Other with its typed answers on demand; None as a row; options removed
 * since listed after, muted, "(removed)"; a multiple choice says why its shares add up to more than 100 %.
 *
 * @module pages/FeedbackForms/results/ChoiceResult
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { QuestionAggregate } from '../../../api/feedbackFormsV2Results'
import type { ChoiceQuestion, FormLanguage } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import BarRow from './BarRow'
import { percentOf } from './scoreMath'

interface Row {
  readonly key: string
  readonly label: string
  readonly count: number
  readonly removed?: boolean
  readonly other?: boolean
}

type RemovedOption = { readonly code: string; readonly label: Readonly<Record<string, string>>; readonly count: number }

/** Other's or None's row: shown when the row is on, or when answers still name it. */
function extraRow(key: 'other' | 'none', on: boolean, label: string, fallback: string, count: number): Row[] {
  if (!on && count === 0) return []
  return [{ key, label: label === '' ? fallback : label, count, other: key === 'other' }]
}

function rowsOf(question: ChoiceQuestion, aggregate: QuestionAggregate, removed: readonly RemovedOption[], language: FormLanguage, words: { other: string; none: string }): Row[] {
  const counts = aggregate.counts ?? {}
  const count = (code: string) => counts[code] ?? 0
  const options: Row[] = question.options.map((option) => ({ key: option.code, label: textIn(option.label, language) || option.code, count: count(option.code) }))
  const other = extraRow('other', question.other.enabled, textIn(question.other.label, language), words.other, count('other'))
  const none = question.type === 'multi_select'
    ? extraRow('none', question.none.enabled, textIn(question.none.label, language), words.none, count('none')) : []
  const gone: Row[] = removed.map((option) => ({ key: `removed-${option.code}`, label: option.label[language] ?? option.code, count: option.count, removed: true }))
  return [...options, ...other, ...none, ...gone]
}

function OtherAnswers({ answers }: Readonly<{ answers: readonly string[] }>) {
  const { t } = useTranslation('feedbackForms')
  const [open, setOpen] = useState(false)
  if (answers.length === 0) return null
  return (
    <div className="pl-2">
      <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? t('results.choice.hideOther') : t('results.choice.showOther', { count: answers.length })}
      </button>
      {open && (
        <ul className="mt-1 list-disc space-y-0.5 pl-6 text-sm text-text">
          {answers.map((answer, index) => <li key={`${String(index)}-${answer}`} className="break-words">{answer}</li>)}
        </ul>
      )}
    </div>
  )
}

export default function ChoiceResult({ question, aggregate, removed, language }: Readonly<{
  question: ChoiceQuestion
  aggregate: QuestionAggregate
  removed: readonly RemovedOption[]
  language: FormLanguage
}>) {
  const { t } = useTranslation('feedbackForms')
  const [byCount, setByCount] = useState(false)
  const rows = rowsOf(question, aggregate, removed, language, { other: t('results.other'), none: t('logic.values.none') })
  const shown = byCount ? [...rows].sort((a, b) => b.count - a.count) : rows
  const multi = question.type === 'multi_select'
  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button type="button" className="btn btn-ghost btn-sm" aria-pressed={byCount} onClick={() => setByCount(!byCount)}>
          {t('results.choice.sortByCount')}
        </button>
      </div>
      <ul className="space-y-2" aria-label={t('results.choice.optionsLabel')}>
        {shown.map((row) => (
          <BarRow key={row.key} count={row.count} percent={percentOf(row.count, aggregate.answered)} muted={row.removed === true}
            label={row.removed === true ? t('results.choice.removed', { label: row.label }) : row.label}>
            {row.other === true && <OtherAnswers answers={aggregate.other_answers ?? []} />}
          </BarRow>
        ))}
      </ul>
      {multi && (
        <p className="text-[12px] text-muted">
          {question.max === undefined ? t('results.choice.multiNote') : t('results.choice.multiNoteMax', { count: question.max })}
        </p>
      )}
    </div>
  )
}
