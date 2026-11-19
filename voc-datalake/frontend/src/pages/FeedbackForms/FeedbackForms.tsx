/**
 * @fileoverview The Feedback Forms pages (7.55.00, the forms builder): the list, the template picker and the
 * builder, as paths this page reads itself (builder/builderPaths.ts):
 * `/feedback-forms`, `/feedback-forms/new`, `/feedback-forms/new/<tab>` (an unsaved new form) and
 * `/feedback-forms/<id>/<tab>[/…]`. The old full-screen preview's `/feedback-forms/<id>/preview` goes on to the
 * builder's Questions tab (the preview window replaced it, 7.55.01).
 *
 * @module pages/FeedbackForms
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom'
import { Plus } from 'lucide-react'
import { accountTabPath } from '../Account/accountSections'
import { api } from '../../api/client'
import { feedbackFormsKey, feedbackFormsWithStatsKey, formStatsKey } from '../../api/feedbackFormQueryKeys'
import type { FeedbackForm } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { normalizeFeedbackForms } from './formSchema'
import { useOptimisticFormDelete } from './useOptimisticFormDelete'
import FormsListContent from './FormsList'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import { stripTrailingSlashes } from '../../api/baseUrl'
import { builderPath, parseFormsPath, pickerPath } from './builder/builderPaths'
import FormBuilderPage from './builder/FormBuilderPage'
import TemplatePicker from './picker/TemplatePicker'

/** The delete confirmation, naming the form; the generic text when it has no name. */
function deleteConfirmMessage(t: TFunction<'feedbackForms'>, forms: readonly FeedbackForm[] | undefined, formId: string | null): string {
  const name = forms?.find((f) => f.form_id === formId)?.name.trim() ?? ''
  return name === '' ? t('deleteConfirmMessage') : t('deleteConfirmMessageNamed', { name })
}

/** The list of forms (UX §14.2): New form, then the list (its banner, toolbar and cards, or the empty state's start). */
function FormsListPage({ apiEndpoint }: Readonly<{ apiEndpoint: string }>) {
  const { t } = useTranslation('feedbackForms')
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const [deleteFormId, setDeleteFormId] = useState<string | null>(null)

  const { data: formsData, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: feedbackFormsWithStatsKey(),
    // One request for the list AND every card's stats (E2E F11): the stats seed each card's `formStatsKey` entry,
    // which FormCard (and Prioritization's evidence panel) read with the shared stale time.
    queryFn: async () => {
      const data = await api.getFeedbackFormsWithStats()
      for (const [formId, stats] of Object.entries(data.stats ?? {})) {
        queryClient.setQueryData(formStatsKey(formId), { success: true, form_id: formId, stats })
      }
      return data
    },
    // Stored forms can predate newer fields: normalized once at the query boundary (issue #171).
    select: (data) => ({ ...data, forms: normalizeFeedbackForms(data.forms) }),
  })
  const deleteMutation = useOptimisticFormDelete()
  const toggleMutation = useMutation({
    mutationFn: ({ formId, enabled }: { formId: string; enabled: boolean }) => api.updateFeedbackForm(formId, { enabled }),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: feedbackFormsKey() }) },
  })
  const openPicker = () => { void navigate(pickerPath()) }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
        <PageTitle title={t('title')} subtitle={t('subtitle')} />
        <button type="button" onClick={openPicker} className="btn btn-primary w-full sm:w-auto">
          <Plus size={16} aria-hidden="true" />
          {t('newForm')}
        </button>
      </div>

      <FormsListContent
        isLoading={isLoading}
        loadFailed={isError && formsData === undefined ? { retry: () => void refetch(), retrying: isFetching } : null}
        forms={formsData?.forms}
        stats={formsData?.stats ?? null}
        onDelete={setDeleteFormId}
        onToggle={(formId, enabled) => toggleMutation.mutate({ formId, enabled })}
        apiEndpoint={apiEndpoint}
        statsRefreshing={isFetching}
      />

      <ConfirmModal
        isOpen={deleteFormId !== null}
        title={t('deleteConfirmTitle')}
        message={deleteConfirmMessage(t, formsData?.forms, deleteFormId)}
        confirmLabel={t('deleteConfirmLabel')}
        variant="danger"
        isLoading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteFormId !== null) deleteMutation.mutate(deleteFormId, { onSettled: () => setDeleteFormId(null) })
        }}
        onCancel={() => setDeleteFormId(null)}
      />
    </div>
  )
}

export default function FeedbackForms() {
  const { t } = useTranslation('feedbackForms')
  const { config } = useConfigStore()
  const params = useParams()
  const location = useLocation()
  if (!config.apiEndpoint) {
    return (
      <div className="card text-center py-12">
        <p className="text-sm text-muted mb-4">{t('configureApiFirst')}</p>
        <Link to={accountTabPath('preferences')} className="btn btn-primary">{t('common:goToSettings')}</Link>
      </div>
    )
  }
  const place = parseFormsPath(params['*'] ?? '', location.search)
  switch (place.kind) {
    case 'list': return <FormsListPage apiEndpoint={stripTrailingSlashes(config.apiEndpoint)} />
    case 'picker': return <TemplatePicker template={place.template} />
    case 'builder': return <FormBuilderPage formId={place.formId} tab={place.tab} rest={place.rest} />
    case 'preview': return <Navigate to={builderPath(place.formId, 'questions')} replace />
  }
}
