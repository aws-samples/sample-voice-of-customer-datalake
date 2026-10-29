/**
 * The Feedback Forms list: loading, failed read, empty state, the forms people
 * made, and — collapsed underneath — the system forms the platform made for
 * itself (one per built prototype, collecting tester pins). System forms are
 * not something a person creates or shares, so they never sit among the forms
 * the page is about; they stay reachable under "System forms (N)".
 */
import { useTranslation } from 'react-i18next'
import { Plus, Loader2, ClipboardList } from 'lucide-react'
import type { FeedbackForm } from '../../api/types'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import FormCard from './FormCard'
import type { FormCardHandlers } from './FormCard'

/** Forms made by the platform itself (a prototype's pin form), not by a person. */
function isSystemForm(form: FeedbackForm): boolean {
  return form.form_type === 'prototype_pin'
}

type CardHandlers = FormCardHandlers

function FormCards({ forms, handlers }: Readonly<{ forms: readonly FeedbackForm[]; handlers: CardHandlers }>) {
  return (
    <div className="space-y-4">
      {forms.map((form) => (
        <FormCard
          key={form.form_id}
          form={form}
          onEdit={handlers.onEdit}
          onDelete={handlers.onDelete}
          onToggle={handlers.onToggle}
          apiEndpoint={handlers.apiEndpoint}
          statsRefreshing={handlers.statsRefreshing}
        />
      ))}
    </div>
  )
}

function EmptyForms({ onCreateNew }: Readonly<{ onCreateNew: () => void }>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="card text-center py-12">
      <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-accent-subtle flex items-center justify-center">
        <ClipboardList size={20} className="text-accent-text" aria-hidden="true" />
      </div>
      <h2 className="text-base font-semibold tracking-tight text-text-strong mb-1">{t('empty.title')}</h2>
      <p className="text-sm text-muted mb-4">{t('empty.description')}</p>
      <button onClick={onCreateNew} className="btn btn-primary">
        <Plus size={16} aria-hidden="true" />
        {t('empty.createButton')}
      </button>
    </div>
  )
}

function SystemForms({ forms, handlers }: Readonly<{ forms: readonly FeedbackForm[]; handlers: CardHandlers }>) {
  const { t } = useTranslation('feedbackForms')
  if (forms.length === 0) return null
  return (
    <details className="card">
      <summary className="cursor-pointer text-sm font-medium text-text-strong focus-ring rounded-md">
        {t('systemForms.title', { n: forms.length })}
      </summary>
      <p className="text-sm text-muted mt-2 mb-4">{t('systemForms.description')}</p>
      <FormCards forms={forms} handlers={handlers} />
    </details>
  )
}

export default function FormsListContent({
  isLoading,
  loadFailed,
  forms,
  onCreateNew,
  ...handlers
}: Readonly<CardHandlers & {
  isLoading: boolean
  /** The list read failed and nothing is cached: say so, never "no forms yet". */
  loadFailed: { retry: () => void; retrying: boolean } | null
  forms: readonly FeedbackForm[] | undefined
  onCreateNew: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  if (isLoading) {
    return (
      <div role="status" aria-label={t('common:loading')} className="flex items-center justify-center py-12">
        <Loader2 className="animate-spin text-accent" size={24} aria-hidden="true" />
      </div>
    )
  }
  if (loadFailed !== null) {
    return <LoadFailed onRetry={loadFailed.retry} retrying={loadFailed.retrying} />
  }
  const all = forms ?? []
  const own = all.filter((form) => !isSystemForm(form))
  const system = all.filter(isSystemForm)
  return (
    <div className="space-y-4">
      {own.length > 0 ? <FormCards forms={own} handlers={handlers} /> : <EmptyForms onCreateNew={onCreateNew} />}
      <SystemForms forms={system} handlers={handlers} />
    </div>
  )
}
