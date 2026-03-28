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

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import {
  Plus, Loader2, Eye,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { stripTrailingSlashes } from '../../api/baseUrl'
import { api } from '../../api/client'
import { feedbackFormsApi } from '../../api/feedbackFormsApi'
import ConfirmModal from '../../components/ConfirmModal'
import { useConfigStore } from '../../store/configStore'
import FormCard from './FormCard'
import FormEditor from './FormEditor'
import TemplateWizard from './TemplateWizard'
import type { FeedbackForm } from '../../api/types'

function FormsListContent({
  isLoading,
  forms,
  onEdit,
  onDelete,
  onToggle,
  onCreateNew,
  apiEndpoint,
}: Readonly<{
  isLoading: boolean
  forms: FeedbackForm[] | undefined
  onEdit: (form: FeedbackForm) => void
  onDelete: (formId: string) => void
  onToggle: (formId: string, enabled: boolean) => void
  onCreateNew: () => void
  apiEndpoint: string
}>) {
  const { t } = useTranslation('feedbackForms')
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="animate-spin text-blue-600" size={32} />
      </div>
    )
  }

  if (forms && forms.length > 0) {
    return (
      <div className="space-y-4">
        {forms.map((form) => (
          <FormCard
            key={form.form_id}
            form={form}
            onEdit={onEdit}
            onDelete={onDelete}
            onToggle={onToggle}
            apiEndpoint={apiEndpoint}
          />
        ))}
      </div>
    )
  }

  return (
    <div className="card text-center py-12">
      <div className="text-4xl mb-4">📝</div>
      <h3 className="text-lg font-medium text-gray-900 mb-2">{t('empty.title')}</h3>
      <p className="text-gray-500 mb-4">{t('empty.description')}</p>
      <button onClick={onCreateNew} className="btn btn-primary inline-flex items-center gap-2">
        <Plus size={18} />
        {t('empty.createButton')}
      </button>
    </div>
  )
}

export default function FeedbackForms() {
  const { t } = useTranslation('feedbackForms')
  const queryClient = useQueryClient()
  const { config } = useConfigStore()
  const [editingForm, setEditingForm] = useState<FeedbackForm | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const [templateConfig, setTemplateConfig] = useState<Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> | null>(null)
  const [deleteFormId, setDeleteFormId] = useState<string | null>(null)

  const {
    data: formsData, isLoading,
  } = useQuery({
    queryKey: ['feedback-forms'],
    queryFn: () => feedbackFormsApi.getFeedbackForms(),
    enabled: config.apiEndpoint.length > 0,
  })

  const { data: categoriesData } = useQuery({
    queryKey: ['categories-config'],
    queryFn: () => api.getCategoriesConfig(),
    enabled: config.apiEndpoint.length > 0,
  })

  const saveMutation = useMutation({
    mutationFn: (form: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> & { form_id?: string }) =>
      form.form_id != null && form.form_id !== '' ? feedbackFormsApi.updateFeedbackForm(form.form_id, form) : feedbackFormsApi.createFeedbackForm(form),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
      setEditingForm(null)
      setTemplateConfig(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (formId: string) => feedbackFormsApi.deleteFeedbackForm(formId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({
      formId, enabled,
    }: {
      formId: string;
      enabled: boolean
    }) =>
      feedbackFormsApi.updateFeedbackForm(formId, { enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
    },
  })

  const handleDelete = (formId: string) => {
    setDeleteFormId(formId)
  }

  const apiEndpoint = stripTrailingSlashes(config.apiEndpoint)
  const categories = categoriesData?.categories ?? []

  if (config.apiEndpoint === '') {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="card text-center py-12">
          <p className="text-gray-500 mb-4">{t('configureApiFirst')}</p>
          <a href="/settings" className="btn btn-primary">{t('goToSettings', { ns: 'common' })}</a>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm sm:text-base text-gray-500">{t('subtitle')}</p>
        </div>
        <button
          onClick={() => setShowWizard(true)}
          className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
        >
          <Plus size={18} />
          {t('createForm')}
        </button>
      </div>

      {/* Info banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-medium text-blue-900 mb-2 flex items-center gap-2">
          <Eye size={16} /> {t('infoBanner.title')}
        </h4>
        <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
          <li>{t('infoBanner.item1')}</li>
          <li>{t('infoBanner.item2')}</li>
          <li>{t('infoBanner.item3')}</li>
          <li>{t('infoBanner.item4')}</li>
        </ul>
      </div>

      {/* Forms list */}
      <FormsListContent
        isLoading={isLoading}
        forms={formsData?.forms}
        onEdit={setEditingForm}
        onDelete={handleDelete}
        onToggle={(formId, enabled) => toggleMutation.mutate({
          formId,
          enabled,
        })}
        onCreateNew={() => setShowWizard(true)}
        apiEndpoint={apiEndpoint}
      />

      {/* Template Wizard */}
      {showWizard ? <TemplateWizard
        onSelect={(templateCfg) => {
          setTemplateConfig(templateCfg)
          setShowWizard(false)
        }}
        onCancel={() => setShowWizard(false)}
      /> : null}

      {/* Editor modal */}
      {(templateConfig || editingForm) ? <FormEditor
        form={editingForm}
        initialConfig={templateConfig}
        categories={categories}
        onSave={(form) => saveMutation.mutate(form)}
        onCancel={() => {
          setEditingForm(null)
          setTemplateConfig(null)
        }}
        isSaving={saveMutation.isPending}
      /> : null}

      <ConfirmModal
        isOpen={deleteFormId !== null}
        title={t('deleteConfirmTitle')}
        message={t('deleteConfirmMessage')}
        confirmLabel={t('deleteConfirmLabel')}
        variant="danger"
        isLoading={deleteMutation.isPending}
        onConfirm={() => {
          if (deleteFormId != null && deleteFormId !== '') {
            deleteMutation.mutate(deleteFormId, { onSettled: () => setDeleteFormId(null) })
          }
        }}
        onCancel={() => setDeleteFormId(null)}
      />
    </div>
  )
}
