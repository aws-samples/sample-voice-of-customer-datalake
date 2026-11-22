/**
 * @fileoverview The wizard's Confirm step. A survey export: the imported form's name and the questions it becomes
 * (the builder's type chips, each question's options or rows), the columns left out and why, and that the form stays
 * off with no public link. Reviews or tickets: which columns are the text, the rating, the date and the id, and which
 * are left out. Then Import, with its progress.
 *
 * @module pages/Scrapers/ImportWizard/ConfirmStep
 */
import { Loader2 } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { ColumnKind, InferredForm } from '../../../api/importWizardSchema'
import TypeChip from '../../FeedbackForms/ui/TypeChip'
import type { ConfirmProblem, ImportWizardState } from './useImportWizard'
import { columnKindLabel } from './columnText'
import { inferredQuestions } from './inferredQuestions'
import type { InferredQuestion } from './inferredQuestions'
import StickyActionBar from '../../../components/StickyActionBar/StickyActionBar'

const PROBLEM_KEYS: Readonly<Record<ConfirmProblem, string>> = {
  noText: 'importWizard.map.problems.noText',
  noQuestion: 'importWizard.map.problems.noQuestion',
  surveyTooLarge: 'importWizard.confirm.problems.surveyTooLarge',
  noForm: 'importWizard.confirm.problems.noForm',
}

function QuestionLine({ question }: Readonly<{ question: InferredQuestion }>) {
  const { t } = useTranslation('scrapers')
  const headline = Object.values(question.headline)[0] ?? question.id
  const options = question.options?.length ?? 0
  const rows = question.rows?.length ?? 0
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2">
      <TypeChip question={question} />
      <span className="text-sm text-text-strong min-w-0 break-words">{headline}</span>
      {options > 0 && <span className="text-xs text-muted">{t('importWizard.confirm.options', { count: options })}</span>}
      {rows > 0 && <span className="text-xs text-muted">{t('importWizard.confirm.matrixRows', { count: rows, columns: question.columns?.length ?? 0 })}</span>}
    </li>
  )
}

function SurveySummary({ wizard, form }: Readonly<{ wizard: ImportWizardState; form: InferredForm }>) {
  const { t } = useTranslation('scrapers')
  const nameId = useId()
  const left = Object.entries(form.mapping).filter(([, target]) => target === 'ignore').map(([header]) => header)
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label htmlFor={nameId} className="text-sm font-medium text-text-strong">{t('importWizard.confirm.formName')}</label>
        <input id={nameId} className="input" value={wizard.name} maxLength={120} onChange={(event) => wizard.setName(event.target.value)} />
      </div>
      <h3 className="text-xs font-semibold uppercase tracking-[.08em] text-muted">{t('importWizard.confirm.questions')}</h3>
      <ul className="space-y-1.5">{inferredQuestions(form).map((question) => <QuestionLine key={question.id} question={question} />)}</ul>
      {form.problems.map((problem) => (
        <p key={problem.header} className="text-xs text-warn">{t(`importWizard.confirm.formProblems.${problem.code}`, { header: problem.header, defaultValue: problem.header })}</p>
      ))}
      {left.length > 0 && <p className="text-xs text-muted">{t('importWizard.confirm.leftOut', { headers: left.join(', ') })}</p>}
      <p className="text-xs text-muted">{t('importWizard.confirm.off')}</p>
    </div>
  )
}

const SUMMARY_KINDS: readonly ColumnKind[] = ['open_text', 'rating_1_5', 'rating_1_10', 'csat', 'date', 'id', 'channel']

function ReviewsSummary({ wizard }: Readonly<{ wizard: ImportWizardState }>) {
  const { t } = useTranslation('scrapers')
  const headersOf = (kind: ColumnKind) => Object.entries(wizard.kinds).filter(([, k]) => k === kind).map(([h]) => h)
  const dropped = Object.entries(wizard.kinds).filter(([, k]) => k === 'ignore' || k === 'email' || k === 'name')
  return (
    <div className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-[.08em] text-muted">{t('importWizard.confirm.reviews')}</h3>
      <dl className="grid gap-1 text-sm sm:grid-cols-[12rem_1fr]">
        {SUMMARY_KINDS.filter((kind) => headersOf(kind).length > 0).map((kind) => (
          <div key={kind} className="contents">
            <dt className="text-muted">{columnKindLabel(t, kind)}</dt>
            <dd className="text-text-strong break-words">{headersOf(kind).join(', ')}</dd>
          </div>
        ))}
      </dl>
      {dropped.length > 0 && <p className="text-xs text-muted">{t('importWizard.confirm.leftOut', { headers: dropped.map(([h]) => h).join(', ') })}</p>}
      <p className="text-xs text-muted">{t('importWizard.confirm.otherColumns')}</p>
    </div>
  )
}

export default function ConfirmStep({ wizard }: Readonly<{ wizard: ImportWizardState }>) {
  const { t } = useTranslation('scrapers')
  const ids = useId()
  const { detected, progress, confirmProblem, form } = wizard
  if (detected === null) return null
  return (
    <section className="card space-y-5" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="text-sm font-semibold text-text-strong">{t('importWizard.steps.confirm')}</h2>
      {wizard.target === 'survey' && form !== null ? <SurveySummary wizard={wizard} form={form} /> : <ReviewsSummary wizard={wizard} />}
      <p className="text-sm text-text">{t('importWizard.confirm.rowsToImport', { count: detected.table.rows.length })}</p>
      {confirmProblem !== null && <p role="alert" className="text-sm text-danger">{t(PROBLEM_KEYS[confirmProblem])}</p>}
      {progress !== null && (
        <p role="status" className="text-sm text-muted inline-flex items-center gap-2">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          {t('importWizard.confirm.importing', { done: progress.done, total: progress.total })}
        </p>
      )}
      <StickyActionBar variant="footer" className="flex justify-between gap-2">
        <button type="button" className="btn btn-secondary" disabled={wizard.busy} onClick={() => wizard.setStep('map')}>{t('importWizard.back')}</button>
        <button type="button" className="btn btn-primary" disabled={confirmProblem !== null || wizard.busy || wizard.name.trim() === ''}
          onClick={() => void wizard.start()}>{t('importWizard.confirm.start')}</button>
      </StickyActionBar>
    </section>
  )
}
