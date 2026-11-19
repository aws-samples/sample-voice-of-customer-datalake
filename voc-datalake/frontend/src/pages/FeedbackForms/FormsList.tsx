/**
 * The Feedback Forms list: loading (three card skeletons), a failed read, the empty state (the start itself:
 * Describe and three templates), the forms people made (under the dismissible "How feedback forms work", and past
 * six forms a toolbar: search, state, sort), and — collapsed underneath — the system forms the platform made for
 * itself (one per built prototype, collecting tester pins). System forms are not something a person creates or
 * shares, so they never sit among the forms the page is about; they stay reachable under "System forms (N)".
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { SearchX } from 'lucide-react'
import type { FeedbackForm } from '../../api/types'
import type { FormStats } from '../../api/feedbackFormStatsSchema'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import Notice from '../../components/Notice/Notice'
import FormCard from './FormCard'
import type { FormCardHandlers } from './FormCard'
import FormsEmpty from './FormsEmpty'
import { FormsIntroBanner } from './FormsIntro'
import FormsToolbar from './FormsToolbar'
import { ALL_FORMS, TOOLBAR_FROM, narrowsForms, visibleForms } from './formsListFilter'
import type { FormsQuery } from './formsListFilter'

/** Forms made by the platform itself (a prototype's pin form), not by a person. */
function isSystemForm(form: FeedbackForm): boolean {
  return form.form_type === 'prototype_pin'
}

type CardHandlers = FormCardHandlers

function FormCards({ forms, handlers }: Readonly<{ forms: readonly FeedbackForm[]; handlers: CardHandlers }>) {
  return (
    <ul className="space-y-4">
      {forms.map((form) => (
        <li key={form.form_id}>
          <FormCard
            form={form}
            onDelete={handlers.onDelete}
            onToggle={handlers.onToggle}
            apiEndpoint={handlers.apiEndpoint}
            statsRefreshing={handlers.statsRefreshing}
          />
        </li>
      ))}
    </ul>
  )
}

/** Three cards in the list card's shape while the list is read (the design system's Loading row). */
function CardSkeletons() {
  const { t } = useTranslation('feedbackForms')
  return (
    <div role="status" aria-label={t('common:loading')} className="space-y-4">
      {[0, 1, 2].map((index) => (
        <div key={index} aria-hidden="true" data-testid="form-card-skeleton"
          className="card grid gap-3 lg:grid-cols-[minmax(0,1fr)_10rem_auto] lg:items-start lg:gap-x-5">
          <div className="space-y-2"><div className="skeleton h-4 w-1/2" /><div className="skeleton h-4 w-1/3" /></div>
          <div className="space-y-2"><div className="skeleton h-4 w-16" /><div className="skeleton h-4 w-24" /></div>
          <div className="skeleton h-4 w-48" />
        </div>
      ))}
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

/** The person's own forms: the toolbar past six, then the cards it keeps (or why none match). */
function OwnForms({ forms, stats, handlers }: Readonly<{
  forms: readonly FeedbackForm[]
  stats: Readonly<Record<string, FormStats>> | null
  handlers: CardHandlers
}>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const [query, setQuery] = useState<FormsQuery>(ALL_FORMS)
  const withToolbar = forms.length >= TOOLBAR_FROM
  const shown = withToolbar ? visibleForms(forms, query, stats, i18n.language) : forms
  return (
    <div className="space-y-4">
      {withToolbar && <FormsToolbar query={query} onChange={setQuery} shown={shown.length} total={forms.length} />}
      {shown.length > 0
        ? <FormCards forms={shown} handlers={handlers} />
        : (
          <Notice variant="empty" icon={SearchX} title={t('list.noMatchTitle')} text={t('list.noMatch')}
            action={narrowsForms(query) ? { label: t('list.clear'), onClick: () => setQuery(ALL_FORMS) } : undefined} />
        )}
    </div>
  )
}

export default function FormsListContent({
  isLoading,
  loadFailed,
  forms,
  stats,
  ...handlers
}: Readonly<CardHandlers & {
  isLoading: boolean
  /** The list read failed and nothing is cached: say so, never "no forms yet". */
  loadFailed: { retry: () => void; retrying: boolean } | null
  forms: readonly FeedbackForm[] | undefined
  /** The list's per-form stats (the Responses sort); null when the list came without them. */
  stats: Readonly<Record<string, FormStats>> | null
}>) {
  if (isLoading) return <CardSkeletons />
  if (loadFailed !== null) {
    return <LoadFailed onRetry={loadFailed.retry} retrying={loadFailed.retrying} />
  }
  const all = forms ?? []
  const own = all.filter((form) => !isSystemForm(form))
  const system = all.filter(isSystemForm)
  return (
    <div className="space-y-4">
      {own.length > 0
        ? <><FormsIntroBanner /><OwnForms forms={own} stats={stats} handlers={handlers} /></>
        : <FormsEmpty />}
      <SystemForms forms={system} handlers={handlers} />
    </div>
  )
}
