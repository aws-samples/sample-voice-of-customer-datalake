/**
 * @fileoverview Administration → General → "In-app feedback" (`/admin/general#app-feedback`, 7.66.00,
 * docs/micro-feedback.md): whether the app asks people, right after a key action, if it was useful and what is
 * missing, which feedback form of this workspace receives the answers, and after which actions.
 *
 * Off by default (`GET|PUT /settings/app-feedback`). The form must be one made from the In-app micro-feedback
 * template (the link opens it in the picker): the server refuses any other (`app_feedback_form_unfit`, its problems
 * listed here); a form that is Off may be chosen, and the card says the thumbs stay hidden until it is on. Its answers
 * are tagged `voc_app` and the dashboards leave them out. Each control saves at once ("Saved"); inside a workspace its
 * admins change it, outside one the deployment's (`useBrandEditRight`: the server's rule); everyone else reads it.
 *
 * @module pages/Settings/AppFeedbackCard
 */
import { useId } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import SavedStatus from '../../components/SavedStatus/SavedStatus'
import { APP_FEEDBACK_ACTIONS, appFeedbackApi, appFeedbackKey } from '../../api/appFeedbackApi'
import type { AppFeedbackAction, AppFeedbackChanges, AppFeedbackConfig, AppFeedbackProblem } from '../../api/appFeedbackApi'
import { api } from '../../api/client'
import { feedbackFormsKey } from '../../api/feedbackFormQueryKeys'
import { apiErrorCode } from '../../lib/errors'
import { apiErrorStatus, HTTP_FORBIDDEN, HTTP_NOT_FOUND } from '../../api/apiErrorStatus'
import { SECTION_TITLE } from './sectionTitle'
import { ReadOnlyNotice, SettingsLoading, SettingsNotice } from './SettingsNotice'

/** The template a fit form is made from (pages/FeedbackForms/templates/appTemplates.ts), opened in the picker. */
const APP_TEMPLATE_PATH = '/feedback-forms/new?template=app_micro_feedback'

const ACTION_KEYS: Readonly<Record<AppFeedbackAction, string>> = {
  personas: 'appFeedback.actions.personas', research: 'appFeedback.actions.research', prfaq: 'appFeedback.actions.prfaq',
  prd: 'appFeedback.actions.prd', prototype: 'appFeedback.actions.prototype', form_draft: 'appFeedback.actions.form_draft',
  import: 'appFeedback.actions.import', engineering_run: 'appFeedback.actions.engineering_run',
}

const PROBLEM_KEYS: Readonly<Record<AppFeedbackProblem, string>> = {
  not_tagged: 'appFeedback.problems.not_tagged', no_verdict: 'appFeedback.problems.no_verdict',
  no_missing: 'appFeedback.problems.no_missing', hidden_fields: 'appFeedback.problems.hidden_fields',
  form_off: 'appFeedback.problems.form_off',
}

/** The save's refusal, in words. */
function saveErrorKey(error: unknown): string {
  const code = apiErrorCode(error)
  if (code === 'app_feedback_form_unfit') return 'appFeedback.errors.unfit'
  if (code === 'app_feedback_form_required') return 'appFeedback.errors.required'
  if (apiErrorStatus(error) === HTTP_NOT_FOUND) return 'appFeedback.errors.notFound'
  if (apiErrorStatus(error) === HTTP_FORBIDDEN) return 'appFeedback.readOnly'
  return 'appFeedback.errors.saveFailed'
}

function FormState({ config }: Readonly<{ config: AppFeedbackConfig }>) {
  const { t } = useTranslation('settings')
  const form = config.form
  if (form === null) return <p className="text-sm text-muted">{t('appFeedback.noForm')}</p>
  if (!form.found) return <SettingsNotice text={t('appFeedback.formDeleted')} />
  return (
    <div className="space-y-1">
      <p role="status" className="text-sm text-text">
        {config.active ? t('appFeedback.active', { name: form.name }) : t('appFeedback.inactive', { name: form.name })}
      </p>
      {form.problems.length > 0 && (
        <ul className="list-disc pl-5 text-sm text-muted">
          {form.problems.map((problem) => <li key={problem}>{t(PROBLEM_KEYS[problem])}</li>)}
        </ul>
      )}
    </div>
  )
}

function useSaveAppFeedback() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (changes: AppFeedbackChanges) => appFeedbackApi.save(changes),
    onSuccess: (saved) => { queryClient.setQueryData(appFeedbackKey(), saved) },
  })
}

function Controls({ config, canEdit }: Readonly<{ config: AppFeedbackConfig; canEdit: boolean }>) {
  const { t } = useTranslation('settings')
  const formSelect = useId()
  const save = useSaveAppFeedback()
  const forms = useQuery({ queryKey: feedbackFormsKey(), queryFn: () => api.getFeedbackForms(), enabled: canEdit })
  const choices = (forms.data?.forms ?? []).filter((form) => form.form_type !== 'prototype_pin')
  const disabled = !canEdit || save.isPending
  const toggleAction = (action: AppFeedbackAction, on: boolean) => {
    const actions = APP_FEEDBACK_ACTIONS.filter((known) => (known === action ? on : config.actions.includes(known)))
    if (actions.length > 0) save.mutate({ actions })
  }
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <label htmlFor={formSelect} className="block text-sm font-medium text-text">{t('appFeedback.form')}</label>
        <select id={formSelect} className="input w-full max-w-md" disabled={disabled} value={config.form_id ?? ''}
          onChange={(event) => save.mutate({ form_id: event.target.value === '' ? null : event.target.value })}>
          <option value="">{t('appFeedback.noFormOption')}</option>
          {config.form_id !== null && !choices.some((form) => form.form_id === config.form_id) && (
            <option value={config.form_id}>{config.form?.name ?? config.form_id}</option>
          )}
          {choices.map((form) => <option key={form.form_id} value={form.form_id}>{form.name}</option>)}
        </select>
        <p className="text-xs text-muted">
          <Link to={APP_TEMPLATE_PATH} className="link">{t('appFeedback.createForm')}</Link>
        </p>
      </div>
      <FormState config={config} />
      <label className="flex items-center gap-2 text-sm text-text">
        <input type="checkbox" className="rounded-sm accent-accent" checked={config.enabled}
          disabled={disabled || (config.form_id === null && !config.enabled)}
          onChange={(event) => save.mutate({ enabled: event.target.checked })} />
        {t('appFeedback.enabled')}
      </label>
      <fieldset className="space-y-1" disabled={disabled}>
        <legend className="text-sm font-medium text-text">{t('appFeedback.actionsLegend')}</legend>
        <div className="grid gap-1 sm:grid-cols-2">
          {APP_FEEDBACK_ACTIONS.map((action) => (
            <label key={action} className="flex items-center gap-2 text-sm text-text">
              <input type="checkbox" className="rounded-sm accent-accent" checked={config.actions.includes(action)}
                onChange={(event) => toggleAction(action, event.target.checked)} />
              {t(ACTION_KEYS[action])}
            </label>
          ))}
        </div>
      </fieldset>
      {save.isError ? <SettingsNotice text={t(saveErrorKey(save.error))} /> : <SavedStatus saved={save.isSuccess} />}
    </div>
  )
}

export default function AppFeedbackCard({ apiEndpoint, canEdit }: Readonly<{ apiEndpoint: string; canEdit: boolean }>) {
  const { t } = useTranslation('settings')
  const titleId = useId()
  const query = useQuery({ queryKey: appFeedbackKey(), queryFn: appFeedbackApi.get, enabled: apiEndpoint !== '' })
  if (apiEndpoint === '') return null
  return (
    <section className="card space-y-4" aria-labelledby={titleId}>
      <div>
        <h2 id={titleId} className={SECTION_TITLE}>{t('appFeedback.title')}</h2>
        <p className="mt-0.5 text-sm text-muted">{t('appFeedback.hint')}</p>
      </div>
      {canEdit ? null : <ReadOnlyNotice text={t('appFeedback.readOnly')} />}
      {query.isLoading ? <SettingsLoading text={t('appFeedback.loading')} /> : null}
      {query.isError ? <SettingsNotice text={t('appFeedback.loadFailed')} /> : null}
      {query.data === undefined ? null : <Controls config={query.data} canEdit={canEdit} />}
    </section>
  )
}
