/**
 * @fileoverview The wizard's Map step: what the file is (reviews or tickets, or a survey export), how its dates are
 * written, and each column's kind (ColumnCard).
 *
 * @module pages/Scrapers/ImportWizard/MapStep
 */
import { Loader2 } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import RadioCard from '../../../components/RadioCard/RadioCard'
import { DATE_ORDERS } from '../../../api/importWizardSchema'
import type { DateOrder, ImportTarget } from '../../../api/importWizardSchema'
import ColumnCard from './ColumnCard'
import type { ImportWizardState } from './useImportWizard'
import { mappingProblem } from './wizardMapping'

const TARGETS: readonly ImportTarget[] = ['reviews', 'survey']
const TARGET_KEYS: Readonly<Record<ImportTarget, { readonly title: string; readonly hint: string }>> = {
  reviews: { title: 'importWizard.map.targets.reviews.title', hint: 'importWizard.map.targets.reviews.description' },
  survey: { title: 'importWizard.map.targets.survey.title', hint: 'importWizard.map.targets.survey.description' },
}
const PROBLEM_KEYS = {
  noText: 'importWizard.map.problems.noText',
  noQuestion: 'importWizard.map.problems.noQuestion',
} as const

export default function MapStep({ wizard }: Readonly<{ wizard: ImportWizardState }>) {
  const { t } = useTranslation('scrapers')
  const ids = useId()
  const { detected } = wizard
  if (detected === null) return null
  const hasDates = Object.values(wizard.kinds).includes('date')
  const problem = mappingProblem(wizard.kinds, wizard.target)
  return (
    <section className="card space-y-5" aria-labelledby={`${ids}-title`}>
      <h2 id={`${ids}-title`} className="text-sm font-semibold text-text-strong">{t('importWizard.steps.map')}</h2>
      <fieldset className="space-y-2">
        <legend className="text-xs font-semibold uppercase tracking-[.08em] text-muted mb-1">{t('importWizard.map.target')}</legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {TARGETS.map((target) => (
            <RadioCard key={target} name={`${ids}-target`} value={target} checked={wizard.target === target}
              onSelect={wizard.setTarget} title={t(TARGET_KEYS[target].title)} hint={t(TARGET_KEYS[target].hint)} />
          ))}
        </div>
      </fieldset>
      {hasDates && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${ids}-dates`} className="text-sm text-text">{t('importWizard.map.dateOrder')}</label>
          <select id={`${ids}-dates`} className="select w-auto text-sm" value={wizard.dateOrder}
            onChange={(event) => wizard.setDateOrder(DATE_ORDERS.find((order) => order === event.target.value) ?? 'dmy')}>
            {DATE_ORDERS.map((order: DateOrder) => <option key={order} value={order}>{t(`importWizard.map.dateOrders.${order}`)}</option>)}
          </select>
        </div>
      )}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-[.08em] text-muted mb-2">{t('importWizard.map.columns')}</h3>
        <ul className="grid gap-2 sm:grid-cols-2">
          {detected.answer.columns.map((column) => (
            <ColumnCard key={column.header} column={column} kind={wizard.kinds[column.header] ?? column.kind}
              onKind={(kind) => wizard.setKind(column.header, kind)} />
          ))}
        </ul>
      </div>
      {problem !== null && <p role="alert" className="text-sm text-danger">{t(PROBLEM_KEYS[problem])}</p>}
      <div className="flex justify-between gap-2">
        <button type="button" className="btn btn-secondary" onClick={() => wizard.setStep('upload')}>{t('importWizard.back')}</button>
        <button type="button" className="btn btn-primary" disabled={problem !== null || wizard.busy}
          onClick={() => void wizard.toConfirm()}>
          {wizard.busy && <Loader2 size={14} className="animate-spin" aria-hidden="true" />}
          {t('importWizard.continue')}
        </button>
      </div>
    </section>
  )
}
