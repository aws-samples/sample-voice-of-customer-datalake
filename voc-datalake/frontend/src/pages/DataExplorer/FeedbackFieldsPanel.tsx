/**
 * @fileoverview "Fields" on the Data Explorer's processed tab: a reference table of what every stored field
 * of a feedback item means (`GET /feedback/catalogue`, docs/data-catalogue.md, TENETS.md D7): its type, its
 * meaning, the pipeline steps that set it, whether it holds personal data, what a `redact` / `summary_only`
 * source policy does to it and its allowed values. Collapsed by default; the read starts when it opens and is
 * kept for an hour (the catalogue changes only with a deployment). The meanings are the server's English text.
 * @module pages/DataExplorer/FeedbackFieldsPanel
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import CollapsibleSection from '../../components/CollapsibleSection/CollapsibleSection'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { FEEDBACK_CATALOGUE_KEY, FEEDBACK_CATALOGUE_STALE_MS, getFeedbackCatalogue } from '../../api/feedbackCatalogueApi'
import { fieldValues } from '../../api/feedbackCatalogueSchema'
import type { CatalogueField, CatalogueStep, FeedbackCatalogue } from '../../api/feedbackCatalogueSchema'
import { useConfigStore } from '../../store/configStore'
import { failedReads } from '../../utils/failedReads'

type DataExplorerT = TFunction<'dataExplorer'>

/** The PII class as a reader names it (each key literal, so the i18n audit sees it); else the server's word. */
function piiLabel(t: DataExplorerT, pii: string): string {
  switch (pii) {
    case 'customer_text': return t('fields.pii.customer_text')
    case 'personal': return t('fields.pii.personal')
    case 'derived_text': return t('fields.pii.derived_text')
    case 'none': return t('fields.pii.none')
    default: return pii
  }
}

function effectLabel(t: DataExplorerT, effect: string): string {
  switch (effect) {
    case 'kept': return t('fields.effects.kept')
    case 'redacted': return t('fields.effects.redacted')
    case 'dropped': return t('fields.effects.dropped')
    case 'from_redacted': return t('fields.effects.from_redacted')
    case 'replaced': return t('fields.effects.replaced')
    default: return effect
  }
}

function FieldRow({ field, steps, t }: Readonly<{ field: CatalogueField; steps: ReadonlyMap<string, string>; t: DataExplorerT }>) {
  const values = fieldValues(field)
  return (
    <tr className="border-t border-border align-top">
      <th scope="row" className="py-1.5 pr-3 text-left font-mono text-[12px] font-normal text-text-strong whitespace-nowrap">
        {field.name}
        {field.key && <span className="badge badge-muted ml-1">{t('fields.keyBadge')}</span>}
      </th>
      <td className="py-1.5 pr-3 font-mono text-[12px] text-muted">{field.type}</td>
      <td className="py-1.5 pr-3 text-[12px] text-text min-w-[16rem]">{field.meaning}</td>
      <td className="py-1.5 pr-3 text-[12px] text-muted">
        {field.set_by.map((step) => <span key={step} title={steps.get(step)} className="block">{step}</span>)}
      </td>
      <td className="py-1.5 pr-3 text-[12px] text-muted">{piiLabel(t, field.pii)}</td>
      <td className="py-1.5 pr-3 text-[12px] text-muted whitespace-nowrap">
        <span className="block">{t('fields.redact', { effect: effectLabel(t, field.under_redact) })}</span>
        <span className="block">{t('fields.summaryOnly', { effect: effectLabel(t, field.under_summary_only) })}</span>
      </td>
      <td className="py-1.5 text-[12px] text-muted">{values.length === 0 ? '—' : values.join(', ')}</td>
    </tr>
  )
}

function FieldsTable({ catalogue }: Readonly<{ catalogue: FeedbackCatalogue }>) {
  const { t } = useTranslation('dataExplorer')
  if (catalogue.fields.length === 0) return <p className="text-sm text-muted">{t('fields.empty')}</p>
  const steps = new Map(catalogue.steps.map((step: CatalogueStep) => [step.name, step.meaning]))
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm" data-testid="feedback-fields-table">
        <caption className="sr-only">{t('fields.caption', { table: catalogue.table })}</caption>
        <thead>
          <tr className="text-left text-[12px] text-muted">
            <th scope="col" className="pb-1.5 pr-3 font-medium">{t('fields.columns.field')}</th>
            <th scope="col" className="pb-1.5 pr-3 font-medium">{t('fields.columns.type')}</th>
            <th scope="col" className="pb-1.5 pr-3 font-medium">{t('fields.columns.meaning')}</th>
            <th scope="col" className="pb-1.5 pr-3 font-medium">{t('fields.columns.setBy')}</th>
            <th scope="col" className="pb-1.5 pr-3 font-medium">{t('fields.columns.personalData')}</th>
            <th scope="col" className="pb-1.5 pr-3 font-medium">{t('fields.columns.policies')}</th>
            <th scope="col" className="pb-1.5 font-medium">{t('fields.columns.values')}</th>
          </tr>
        </thead>
        <tbody>
          {catalogue.fields.map((field) => <FieldRow key={field.name} field={field} steps={steps} t={t} />)}
        </tbody>
      </table>
    </div>
  )
}

function FieldsBody() {
  const { t } = useTranslation('dataExplorer')
  const { config } = useConfigStore()
  const query = useQuery({
    queryKey: FEEDBACK_CATALOGUE_KEY,
    queryFn: getFeedbackCatalogue,
    staleTime: FEEDBACK_CATALOGUE_STALE_MS,
    enabled: !!config.apiEndpoint,
  })
  const failure = failedReads([query])
  if (failure.loadFailed) return <LoadFailed onRetry={failure.retry} retrying={failure.retrying} />
  if (query.data === undefined) return <p className="text-sm text-muted" role="status">{t('fields.loading')}</p>
  return <FieldsTable catalogue={query.data} />
}

export default function FeedbackFieldsPanel() {
  const { t } = useTranslation('dataExplorer')
  const [open, setOpen] = useState(false)
  return (
    <CollapsibleSection title={t('fields.title')} open={open} onOpenChange={setOpen}>
      <div className="space-y-3">
        <p className="text-sm text-muted">{t('fields.description')}</p>
        <FieldsBody />
      </div>
    </CollapsibleSection>
  )
}
