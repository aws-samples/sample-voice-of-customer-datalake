/**
 * @fileoverview Embeddable feedback forms management page.
 *
 * Features:
 * - Create forms from templates (NPS, CSAT, CES, etc.)
 * - Customize form appearance and fields
 * - Generate embed code (script or iframe)
 * - Preview forms in real-time
 * - Enable/disable forms
 *
 * @module pages/FeedbackForms
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { accountTabPath } from '../Account/accountSections'
import { z } from 'zod'
import { Plus, Info, PowerOff, Power, X } from 'lucide-react'
import { api } from '../../api/client'
import { feedbackFormsKey, feedbackFormsWithStatsKey, formStatsKey } from '../../api/feedbackFormQueryKeys'
import type { FeedbackForm } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { normalizeFeedbackForms } from './formSchema'
import { useOptimisticFormDelete } from './useOptimisticFormDelete'
import { useCategoriesConfig } from '../../hooks/useCategories'
import TemplateWizard from './TemplateWizard'
import FormsListContent from './FormsList'
import FormEditor from './FormEditor'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import { stripTrailingSlashes } from '../../api/baseUrl'

/**
 * The part of a create response the notice reads, validated rather than
 * trusted: a missing or non-boolean `enabled` reads as disabled (the server's
 * default), and a response without an id announces nothing.
 */
const CreatedFormResponseSchema = z.object({
  form: z.object({
    form_id: z.string().min(1),
    name: z.string().catch(''),
    enabled: z.boolean().catch(false),
  }),
})

/** The created form when the response says it is disabled, else null. */
function createdDisabledForm(response: unknown): CreatedDisabledForm | null {
  const parsed = CreatedFormResponseSchema.safeParse(response)
  if (!parsed.success || parsed.data.form.enabled) return null
  return { formId: parsed.data.form.form_id, name: parsed.data.form.name }
}

/** A form just created and still disabled: named, so the notice can say which one. */
interface CreatedDisabledForm {
  readonly formId: string
  readonly name: string
}

/**
 * Shown right after a create that left the form disabled (E2E F6): new forms
 * start off by design, so the owner is told — at the moment they would go and
 * share the link — that it answers "Feedback form unavailable." until enabled,
 * with the enable action one click away.
 */
function CreatedDisabledNotice({ form, onEnable, onDismiss, isEnabling }: Readonly<{
  form: CreatedDisabledForm
  onEnable: () => void
  onDismiss: () => void
  isEnabling: boolean
}>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div role="status" className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-lg border border-warn/30 bg-warn-subtle">
      <PowerOff size={18} className="text-warn flex-shrink-0" aria-hidden="true" />
      <p className="text-sm text-text flex-1">{t('createdDisabled.message', { name: form.name })}</p>
      <div className="flex items-center gap-2">
        <button type="button" onClick={onEnable} disabled={isEnabling} className="btn btn-primary btn-sm">
          <Power size={14} aria-hidden="true" />
          {t('createdDisabled.enable')}
        </button>
        <button type="button" onClick={onDismiss} className="icon-btn p-2 focus-ring" aria-label={t('createdDisabled.dismiss')} title={t('createdDisabled.dismiss')}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
    </div>
  )
}

/** The delete confirmation, naming the form; the generic text when it has no name. */
function deleteConfirmMessage(t: TFunction<'feedbackForms'>, forms: readonly FeedbackForm[] | undefined, formId: string | null): string {
  const name = forms?.find((f) => f.form_id === formId)?.name.trim() ?? ''
  return name === '' ? t('deleteConfirmMessage') : t('deleteConfirmMessageNamed', { name })
}

export default function FeedbackForms() {
  const { t } = useTranslation('feedbackForms')
  const queryClient = useQueryClient()
  const { config } = useConfigStore()
  const [editingForm, setEditingForm] = useState<FeedbackForm | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const [templateConfig, setTemplateConfig] = useState<Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> | null>(null)
  const [deleteFormId, setDeleteFormId] = useState<string | null>(null)
  const [createdDisabled, setCreatedDisabled] = useState<CreatedDisabledForm | null>(null)

  const { data: formsData, isLoading, isError, isFetching, refetch } = useQuery({
    queryKey: feedbackFormsWithStatsKey(),
    // One request for the list AND every card's stats (E2E F11: each card used
    // to fetch its own). The stats seed each card's `formStatsKey` entry, which
    // FormCard (and Prioritization's evidence panel) read with the shared stale
    // time, so no per-card request is made. Without a map (older API, or a
    // failed stats read) nothing is seeded and each card asks for itself.
    queryFn: async () => {
      const data = await api.getFeedbackFormsWithStats()
      for (const [formId, stats] of Object.entries(data.stats ?? {})) {
        queryClient.setQueryData(formStatsKey(formId), { success: true, form_id: formId, stats })
      }
      return data
    },
    // Stored forms can predate newer fields (and fixtures can be sparse):
    // normalize once at the query boundary so FeedbackForm's declared
    // contract is true for every consumer (issue #171).
    select: (data) => ({ ...data, forms: normalizeFeedbackForms(data.forms) }),
    enabled: !!config.apiEndpoint,
  })
  // The confirmation names what it deletes; generic only when the form has no name.
  const deleteMessage = deleteConfirmMessage(t, formsData?.forms, deleteFormId)

  // The shared, normalized config query: legacy rows can lack an id (and
  // subcategories), and without normalization the option list rendered a
  // keyless <option> and a select that could not pick it.
  const { data: categoriesData } = useCategoriesConfig()

  const saveMutation = useMutation({
    mutationFn: (form: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> & { form_id?: string }) =>
      form.form_id ? api.updateFeedbackForm(form.form_id, form) : api.createFeedbackForm(form),
    onSuccess: (response, submitted) => {
      void queryClient.invalidateQueries({ queryKey: feedbackFormsKey() })
      // Only a CREATE that came back disabled; an edit never re-announces.
      setCreatedDisabled(submitted.form_id === undefined ? createdDisabledForm(response) : null)
      setEditingForm(null)
      setTemplateConfig(null)
    },
  })

  const deleteMutation = useOptimisticFormDelete()

  const toggleMutation = useMutation({
    mutationFn: ({ formId, enabled }: { formId: string; enabled: boolean }) =>
      api.updateFeedbackForm(formId, { enabled }),
    onSuccess: (_response, { formId, enabled }) => {
      void queryClient.invalidateQueries({ queryKey: feedbackFormsKey() })
      if (enabled) setCreatedDisabled((current) => (current?.formId === formId ? null : current))
    },
  })

  const handleDelete = (formId: string) => {
    setDeleteFormId(formId)
  }

  const apiEndpoint = stripTrailingSlashes(config.apiEndpoint)
  const categories = categoriesData?.categories ?? []

  if (!config.apiEndpoint) {
    return (
      <div className="card text-center py-12">
        <p className="text-sm text-muted mb-4">{t('configureApiFirst')}</p>
        <Link to={accountTabPath('preferences')} className="btn btn-primary">{t('common:goToSettings')}</Link>
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3 sm:gap-4">
        <PageTitle title={t('title')} subtitle={t('subtitle')} />
        <button
          onClick={() => setShowWizard(true)}
          className="btn btn-primary w-full sm:w-auto"
        >
          <Plus size={16} />
          {t('createForm')}
        </button>
      </div>

      {/* Info banner */}
      <div className="bg-info-subtle border border-info/30 rounded-lg p-4">
        <h2 className="text-sm font-semibold tracking-tight text-info mb-2 flex items-center gap-2">
          <Info size={16} aria-hidden="true" /> {t('infoBanner.title')}
        </h2>
        <ul className="text-sm text-text space-y-1 list-disc list-inside">
          <li>{t('infoBanner.item1')}</li>
          <li>{t('infoBanner.item2')}</li>
          <li>{t('infoBanner.item3')}</li>
          <li>{t('infoBanner.item4')}</li>
        </ul>
      </div>

      {createdDisabled === null ? null : (
        <CreatedDisabledNotice
          form={createdDisabled}
          isEnabling={toggleMutation.isPending}
          onEnable={() => toggleMutation.mutate({ formId: createdDisabled.formId, enabled: true })}
          onDismiss={() => setCreatedDisabled(null)}
        />
      )}

      {/* Forms list */}
      <FormsListContent
        isLoading={isLoading}
        loadFailed={isError && formsData === undefined ? { retry: () => void refetch(), retrying: isFetching } : null}
        forms={formsData?.forms}
        onEdit={setEditingForm}
        onDelete={handleDelete}
        onToggle={(formId, enabled) => toggleMutation.mutate({ formId, enabled })}
        onCreateNew={() => setShowWizard(true)}
        apiEndpoint={apiEndpoint}
        statsRefreshing={isFetching}
      />

      {/* Template Wizard */}
      {showWizard && (
        <TemplateWizard
          onSelect={(config) => {
            setTemplateConfig(config)
            setShowWizard(false)
          }}
          onCancel={() => setShowWizard(false)}
        />
      )}

      {/* Editor modal */}
      {(templateConfig !== null || editingForm !== null) && (
        <FormEditor
          form={editingForm}
          initialConfig={templateConfig}
          categories={categories}
          onSave={(form) => saveMutation.mutateAsync(form)}
          onCancel={() => {
            setEditingForm(null)
            setTemplateConfig(null)
          }}
          isSaving={saveMutation.isPending}
          validationPickerEnabled={!!config.apiEndpoint}
        />
      )}

      <ConfirmModal
        isOpen={deleteFormId !== null}
        title={t('deleteConfirmTitle')}
        message={deleteMessage}
        confirmLabel={t('deleteConfirmLabel')}
        variant="danger"
        isLoading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteFormId) {
            deleteMutation.mutate(deleteFormId, { onSettled: () => setDeleteFormId(null) })
          }
        }}
        onCancel={() => setDeleteFormId(null)}
      />
    </div>
  )
}
