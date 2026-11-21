/**
 * @fileoverview The Validate step's results (7.68.00): per criterion its target, the real testers' average and status
 * (met, not met, not enough data: real testers only), the personas' average beside it labelled synthetic; per task
 * the real success rate and the personas' outcomes; the testers' ease (CES) and what they said was missing.
 * @module pages/ProjectDetail/validation/ValidationResults
 */
import clsx from 'clsx'
import { FlaskConical } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { percent } from './validationModel'
import type { CriterionResult, TaskResult, ValidationView } from '../../../api/validationApi'

const STATUS_TONE: Readonly<Record<CriterionResult['outcome'], string>> = {
  met: 'text-ok', not_met: 'text-danger', not_enough_data: 'text-muted',
}

function SyntheticCell({ result }: Readonly<{ result: CriterionResult }>) {
  const { t } = useTranslation('projectDetail')
  const synthetic = result.synthetic
  if (synthetic?.average == null) return <span className="text-muted">-</span>
  return (
    <span className="inline-flex items-center gap-1 text-muted" data-testid="synthetic-figure">
      <FlaskConical size={12} aria-hidden />
      {t('validation.results.average', { average: synthetic.average, n: synthetic.n })}
      <span className="badge badge-aim">{t('validation.synthetic.label')}</span>
    </span>
  )
}

function CriteriaTable({ criteria }: Readonly<{ criteria: readonly CriterionResult[] }>) {
  const { t } = useTranslation('projectDetail')
  // Literal keys, so the i18n check sees each one.
  const statusLabels: Readonly<Record<CriterionResult['outcome'], string>> = {
    met: t('validation.results.met'), not_met: t('validation.results.not_met'),
    not_enough_data: t('validation.results.not_enough_data'),
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-[12px] text-muted">
            <th scope="col">{t('validation.results.criterion')}</th>
            <th scope="col">{t('validation.results.target')}</th>
            <th scope="col">{t('validation.results.real')}</th>
            <th scope="col">{t('validation.results.status')}</th>
            <th scope="col">{t('validation.results.personas')}</th>
          </tr>
        </thead>
        <tbody>
          {criteria.map((result) => (
            <tr key={result.id} className="border-t border-border align-top">
              <td>{result.text}</td>
              <td className="font-mono">{result.target}</td>
              <td>{result.real.average === null ? t('validation.results.noAnswers')
                : t('validation.results.average', { average: result.real.average, n: result.real.n })}</td>
              <td className={clsx('font-medium', STATUS_TONE[result.outcome])}>{statusLabels[result.outcome]}</td>
              <td><SyntheticCell result={result} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TaskLine({ task }: Readonly<{ task: TaskResult }>) {
  const { t } = useTranslation('projectDetail')
  const rate = percent(task.real.rate)
  return (
    <li className="flex flex-wrap items-baseline justify-between gap-2 py-1.5">
      <span className="min-w-0 flex-1 text-text">{task.text}</span>
      <span className="text-sm">{rate === null ? t('validation.results.noAnswers')
        : t('validation.results.rate', { percent: rate, n: task.real.n })}</span>
      {task.synthetic === null ? null : (
        <span className="inline-flex items-center gap-1 text-xs text-muted">
          <FlaskConical size={12} aria-hidden />
          {t('validation.results.personasDone', { completed: task.synthetic.completed, total: task.synthetic.n })}
        </span>
      )}
    </li>
  )
}

export default function ValidationResults({ view }: Readonly<{ view: ValidationView }>) {
  const { t } = useTranslation('projectDetail')
  const real = view.real
  return (
    <section className="card space-y-3 p-4" aria-label={t('validation.results.title')}>
      <h3 className="text-sm font-semibold text-text-strong">{t('validation.results.title')}</h3>
      <p className="text-sm text-text">{t('validation.results.responses', { n: real?.responses ?? 0 })}</p>
      {view.criteria.length === 0 ? null : <CriteriaTable criteria={view.criteria} />}
      {view.tasks.length === 0 ? null : (
        <ul className="divide-y divide-border" aria-label={t('validation.results.task')}>
          {view.tasks.map((task) => <TaskLine key={task.id} task={task} />)}
        </ul>
      )}
      {real?.ces.average == null ? null : (
        <p className="text-sm text-text">{t('validation.results.ces', { average: real.ces.average, n: real.ces.n })}</p>
      )}
      <div className="space-y-1">
        <h4 className="text-[12px] font-medium text-muted">{t('validation.results.missing')}</h4>
        {real === null || real.missing.length === 0 ? <p className="text-sm text-muted">{t('validation.results.noMissing')}</p> : (
          <ul className="space-y-1">
            {real.missing.map((entry) => <li key={entry.response_id} className="text-sm text-text">“{entry.text}”</li>)}
          </ul>
        )}
      </div>
      <p className="text-[12px] text-muted">{t('validation.synthetic.hint')}</p>
    </section>
  )
}
