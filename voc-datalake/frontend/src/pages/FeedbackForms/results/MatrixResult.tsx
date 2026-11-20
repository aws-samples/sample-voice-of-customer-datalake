/**
 * @fileoverview A matrix question's results (7.61.00, docs/feedback-forms.md "Results and responses"): one chart per
 * row, in the question's row order, with a bar per column (its count and share of those who rated the row) and,
 * when any column has a score, the row's average score. Rows and columns the current revision no longer has are listed
 * after, muted, "(removed)", as a choice's removed options are.
 *
 * @module pages/FeedbackForms/results/MatrixResult
 */
import { useTranslation } from 'react-i18next'
import type { MatrixAggregate, QuestionAggregate } from '../../../api/feedbackFormsV2Results'
import { formatCount, formatDecimal } from '../../../utils/numberFormat'
import type { FormLanguage, MatrixColumn, MatrixQuestion, MatrixRow } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import BarRow from './BarRow'
import { percentOf } from './scoreMath'

type RowFigures = MatrixAggregate['rows'][number]

const NO_FIGURES = (code: string): RowFigures => ({ code, answered: 0, counts: {}, average: null })

/** The score range the columns give (the average's scale), or null when no column has a score. */
function scoreRange(columns: readonly MatrixColumn[]): { readonly low: number; readonly high: number } | null {
  const scores = columns.flatMap((column) => (column.score === undefined ? [] : [column.score]))
  return scores.length === 0 ? null : { low: Math.min(...scores), high: Math.max(...scores) }
}

function RowResult({ row, columns, figures, scored, language }: Readonly<{
  row: MatrixRow
  columns: readonly MatrixColumn[]
  figures: RowFigures
  scored: boolean
  language: FormLanguage
}>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const label = textIn(row.label, language) || row.code
  const range = scoreRange(columns)
  return (
    <li className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="min-w-0 break-words text-sm font-medium text-text-strong">{label}</h4>
        <span className="text-[12px] tabular-nums text-muted">
          {t('results.matrix.rated', { count: figures.answered, formatted: formatCount(figures.answered, i18n.language) })}
          {scored && range !== null && figures.average !== null && (
            <> · {t('results.matrix.average', { average: formatDecimal(figures.average, i18n.language, 1), low: range.low, high: range.high })}</>
          )}
        </span>
      </div>
      <ul className="space-y-2" aria-label={t('results.matrix.columnsLabel', { row: label })}>
        {columns.map((column) => {
          const count = figures.counts[column.code] ?? 0
          return <BarRow key={column.code} label={textIn(column.label, language) || column.code} count={count} percent={percentOf(count, figures.answered)} />
        })}
      </ul>
    </li>
  )
}

/** Answers that name a row or a column the question no longer has, by code. */
function Removed({ rows, columns }: Readonly<{ rows: Readonly<Record<string, number>>; columns: Readonly<Record<string, number>> }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const entries = [
    ...Object.entries(rows).map(([code, count]) => t('results.matrix.removedRow', { code, count, formatted: formatCount(count, i18n.language) })),
    ...Object.entries(columns).map(([code, count]) => t('results.matrix.removedColumn', { code, count, formatted: formatCount(count, i18n.language) })),
  ]
  if (entries.length === 0) return null
  return (
    <ul className="list-disc space-y-0.5 pl-5 text-[12px] text-muted" aria-label={t('results.matrix.removedLabel')}>
      {entries.map((entry) => <li key={entry}>{entry}</li>)}
    </ul>
  )
}

export default function MatrixResult({ question, aggregate, language }: Readonly<{
  question: MatrixQuestion
  aggregate: QuestionAggregate
  language: FormLanguage
}>) {
  const { t } = useTranslation('feedbackForms')
  const matrix = aggregate.matrix
  const byCode = new Map((matrix?.rows ?? []).map((figures) => [figures.code, figures]))
  return (
    <div className="space-y-4">
      <ul className="space-y-5" aria-label={t('results.matrix.rowsLabel')}>
        {question.rows.map((row) => (
          <RowResult key={row.code} row={row} columns={question.columns} figures={byCode.get(row.code) ?? NO_FIGURES(row.code)}
            scored={matrix?.scored === true} language={language} />
        ))}
      </ul>
      <Removed rows={matrix?.removed_rows ?? {}} columns={matrix?.removed_columns ?? {}} />
    </div>
  )
}
