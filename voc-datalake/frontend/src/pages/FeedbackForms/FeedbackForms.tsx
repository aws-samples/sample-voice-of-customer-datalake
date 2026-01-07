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
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  Plus, Loader2, Palette, Settings2, Save, X, Eye
} from 'lucide-react'
import clsx from 'clsx'
import { api } from '../../api/client'
import type { FeedbackForm } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import ConfirmModal from '../../components/ConfirmModal'
import { defaultFormConfig } from './formTemplates'
import TemplateWizard from './TemplateWizard'
import FormCard from './FormCard'


type FormConfig = Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>
type FormConfigWithId = FormConfig & { form_id?: string }

function stripTrailingSlashes(str: string): string {
  if (str.length === 0 || str[str.length - 1] !== '/') return str
  return stripTrailingSlashes(str.slice(0, -1))
}

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
      <h3 className="text-lg font-medium text-gray-900 mb-2">No feedback forms yet</h3>
      <p className="text-gray-500 mb-4">Create your first form to start collecting customer feedback.</p>
      <button onClick={onCreateNew} className="btn btn-primary inline-flex items-center gap-2">
        <Plus size={18} />
        Create Your First Form
      </button>
    </div>
  )
}

interface FormEditorProps {
  readonly form: FeedbackForm | null
  readonly initialConfig?: FormConfig | null
  readonly categories: ReadonlyArray<{ id: string; name: string; subcategories: ReadonlyArray<{ id: string; name: string }> }>
  readonly onSave: (form: FormConfigWithId) => void
  readonly onCancel: () => void
  readonly isSaving?: boolean
}

function getInitialFormData(form: FeedbackForm | null, initialConfig: FormConfig | null | undefined): FormConfigWithId {
  if (form) return { ...form }
  if (initialConfig) return { ...initialConfig }
  return { ...defaultFormConfig }
}

function getSaveButtonText(isSaving: boolean, isEditing: boolean): string {
  if (isSaving) return isEditing ? 'Saving...' : 'Creating...'
  return isEditing ? 'Save Changes' : 'Create Form'
}

function FormEditor({ form, initialConfig, categories, onSave, onCancel, isSaving }: FormEditorProps) {
  const [activeTab, setActiveTab] = useState<'settings' | 'theme' | 'category'>('settings')
  const [formData, setFormData] = useState<FormConfigWithId>(() => getInitialFormData(form, initialConfig))

  const selectedCategory = categories.find(c => c.id === formData.category)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-3 sm:p-4 border-b">
          <h2 className="text-base sm:text-lg font-semibold truncate pr-2">
            {form ? 'Edit Feedback Form' : 'Create New Feedback Form'}
          </h2>
          <button onClick={onCancel} className="p-2 hover:bg-gray-100 rounded-lg flex-shrink-0">
            <X size={20} />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 sm:gap-2 px-3 sm:px-4 pt-3 sm:pt-4 border-b border-gray-200 overflow-x-auto">
          {[
            { id: 'settings', label: 'Form Settings', shortLabel: 'Settings', icon: Settings2 },
            { id: 'category', label: 'Category Routing', shortLabel: 'Category', icon: Settings2 },
            { id: 'theme', label: 'Theme', shortLabel: 'Theme', icon: Palette },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => { 
                const tabId = tab.id
                if (tabId === 'settings' || tabId === 'category' || tabId === 'theme') setActiveTab(tabId) 
              }}
              className={clsx(
                'flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 border-b-2 -mb-px transition-colors whitespace-nowrap text-sm',
                activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              <tab.icon size={16} />
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="sm:hidden">{tab.shortLabel}</span>
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 overflow-auto p-3 sm:p-4">
          {activeTab === 'settings' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
              <div className="space-y-3 sm:space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Form Name (Internal)</label>
                  <input
                    type="text"
                    value={formData.name}
                    onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                    placeholder="e.g., Website Footer Form"
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Form Title</label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Description</label>
                  <textarea
                    value={formData.description}
                    onChange={(e) => setFormData({ ...formData, description: e.target.value })}
                    className="input min-h-[80px]"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Question</label>
                  <input
                    type="text"
                    value={formData.question}
                    onChange={(e) => setFormData({ ...formData, question: e.target.value })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Placeholder Text</label>
                  <input
                    type="text"
                    value={formData.placeholder}
                    onChange={(e) => setFormData({ ...formData, placeholder: e.target.value })}
                    className="input"
                  />
                </div>
              </div>
              <div className="space-y-3 sm:space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Submit Button Text</label>
                  <input
                    type="text"
                    value={formData.submit_button_text}
                    onChange={(e) => setFormData({ ...formData, submit_button_text: e.target.value })}
                    className="input"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Success Message</label>
                  <input
                    type="text"
                    value={formData.success_message}
                    onChange={(e) => setFormData({ ...formData, success_message: e.target.value })}
                    className="input"
                  />
                </div>
                <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.rating_enabled}
                      onChange={(e) => setFormData({ ...formData, rating_enabled: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <span className="text-sm">Enable Rating</span>
                  </label>
                  {formData.rating_enabled && (
                    <select
                      value={formData.rating_type}
                      onChange={(e) => {
                        const val = e.target.value
                        if (val === 'stars' || val === 'numeric' || val === 'emoji') {
                          setFormData({ ...formData, rating_type: val })
                        }
                      }}
                      className="input w-auto"
                    >
                      <option value="stars">Stars ⭐</option>
                      <option value="numeric">Numeric (1-10)</option>
                      <option value="emoji">Emoji 😀</option>
                    </select>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-3 sm:gap-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.collect_name}
                      onChange={(e) => setFormData({ ...formData, collect_name: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <span className="text-sm">Collect Name</span>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={formData.collect_email}
                      onChange={(e) => setFormData({ ...formData, collect_email: e.target.checked })}
                      className="rounded border-gray-300 text-blue-600"
                    />
                    <span className="text-sm">Collect Email</span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'category' && (
            <div className="space-y-4 sm:space-y-6">
              <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
                <h4 className="font-medium text-blue-900 mb-2 text-sm sm:text-base">Category Routing</h4>
                <p className="text-xs sm:text-sm text-blue-800">
                  Assign a category to this form. All feedback submitted through this form will be automatically 
                  tagged with the selected category, making it easy to filter and analyze feedback by source.
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Category</label>
                  <select
                    value={formData.category}
                    onChange={(e) => setFormData({ ...formData, category: e.target.value, subcategory: '' })}
                    className="input"
                  >
                    <option value="">-- Select Category --</option>
                    {categories.map(cat => (
                      <option key={cat.id} value={cat.id}>{cat.name}</option>
                    ))}
                  </select>
                  <p className="text-xs text-gray-500 mt-1">
                    Categories are configured in Settings → Feedback Categories
                  </p>
                </div>

                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Subcategory (Optional)</label>
                  <select
                    value={formData.subcategory}
                    onChange={(e) => setFormData({ ...formData, subcategory: e.target.value })}
                    className="input"
                    disabled={!selectedCategory}
                  >
                    <option value="">-- Select Subcategory --</option>
                    {selectedCategory?.subcategories.map(sub => (
                      <option key={sub.id} value={sub.id}>{sub.name}</option>
                    ))}
                  </select>
                </div>
              </div>

              {formData.category && (
                <div className="p-3 sm:p-4 bg-gray-50 rounded-lg">
                  <p className="text-sm text-gray-700">
                    <strong>Preview:</strong> Feedback from this form will be tagged as:
                  </p>
                  <p className="mt-2 font-mono text-xs sm:text-sm bg-white px-3 py-2 rounded border inline-block break-all">
                    category: "{formData.category}"
                    {formData.subcategory && <>, subcategory: "{formData.subcategory}"</>}
                  </p>
                </div>
              )}
            </div>
          )}

          {activeTab === 'theme' && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
              <div className="space-y-3 sm:space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Primary Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.theme.primary_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, primary_color: e.target.value } })}
                      className="w-10 h-10 rounded border cursor-pointer flex-shrink-0"
                    />
                    <input
                      type="text"
                      value={formData.theme.primary_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, primary_color: e.target.value } })}
                      className="input flex-1 min-w-0"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Background Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.theme.background_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, background_color: e.target.value } })}
                      className="w-10 h-10 rounded border cursor-pointer flex-shrink-0"
                    />
                    <input
                      type="text"
                      value={formData.theme.background_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, background_color: e.target.value } })}
                      className="input flex-1 min-w-0"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Text Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={formData.theme.text_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, text_color: e.target.value } })}
                      className="w-10 h-10 rounded border cursor-pointer flex-shrink-0"
                    />
                    <input
                      type="text"
                      value={formData.theme.text_color}
                      onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, text_color: e.target.value } })}
                      className="input flex-1 min-w-0"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Border Radius</label>
                  <input
                    type="text"
                    value={formData.theme.border_radius}
                    onChange={(e) => setFormData({ ...formData, theme: { ...formData.theme, border_radius: e.target.value } })}
                    placeholder="8px"
                    className="input"
                  />
                </div>
              </div>
              {/* Preview */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Preview</label>
                <div
                  className="relative overflow-hidden border"
                  style={{
                    backgroundColor: formData.theme.background_color,
                    color: formData.theme.text_color,
                    borderRadius: formData.theme.border_radius,
                    minHeight: '240px',
                  }}
                >
                  <div 
                    className="absolute top-0 left-0 h-1 transition-all"
                    style={{ backgroundColor: formData.theme.primary_color, width: '33%' }}
                  />
                  <div className="flex flex-col items-center justify-center text-center p-4 sm:p-6 h-full min-h-[240px]">
                    <h3 className="text-lg sm:text-xl font-bold mb-2 line-clamp-2">{formData.title}</h3>
                    <p className="text-xs sm:text-sm mb-4 opacity-70 max-w-xs line-clamp-2">{formData.description}</p>
                    <button
                      className="px-4 sm:px-5 py-2 text-white font-medium text-sm"
                      style={{ backgroundColor: formData.theme.primary_color, borderRadius: formData.theme.border_radius }}
                    >
                      Start →
                    </button>
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 sm:gap-3 p-3 sm:p-4 border-t bg-gray-50">
          <button onClick={onCancel} className="btn btn-secondary" disabled={isSaving}>
            Cancel
          </button>
          <button
            onClick={() => onSave(formData)}
            disabled={isSaving}
            className="btn btn-primary flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {getSaveButtonText(isSaving ?? false, !!form)}
          </button>
        </div>
      </div>
    </div>
  )
}


export default function FeedbackForms() {
  const queryClient = useQueryClient()
  const { config } = useConfigStore()
  const [editingForm, setEditingForm] = useState<FeedbackForm | null>(null)
  const [showWizard, setShowWizard] = useState(false)
  const [templateConfig, setTemplateConfig] = useState<Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> | null>(null)
  const [deleteFormId, setDeleteFormId] = useState<string | null>(null)

  const { data: formsData, isLoading } = useQuery({
    queryKey: ['feedback-forms'],
    queryFn: () => api.getFeedbackForms(),
    enabled: !!config.apiEndpoint,
  })

  const { data: categoriesData } = useQuery({
    queryKey: ['categories-config'],
    queryFn: () => api.getCategoriesConfig(),
    enabled: !!config.apiEndpoint,
  })

  const saveMutation = useMutation({
    mutationFn: (form: Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'> & { form_id?: string }) =>
      form.form_id ? api.updateFeedbackForm(form.form_id, form) : api.createFeedbackForm(form),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
      setEditingForm(null)
      setTemplateConfig(null)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: (formId: string) => api.deleteFeedbackForm(formId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
    },
  })

  const toggleMutation = useMutation({
    mutationFn: ({ formId, enabled }: { formId: string; enabled: boolean }) =>
      api.updateFeedbackForm(formId, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['feedback-forms'] })
    },
  })

  const handleDelete = (formId: string) => {
    setDeleteFormId(formId)
  }

  const apiEndpoint = stripTrailingSlashes(config.apiEndpoint ?? '')
  const categories = categoriesData?.categories || []

  if (!config.apiEndpoint) {
    return (
      <div className="max-w-4xl mx-auto">
        <div className="card text-center py-12">
          <p className="text-gray-500 mb-4">Configure the API endpoint in Settings to manage feedback forms.</p>
          <a href="/settings" className="btn btn-primary">Go to Settings</a>
        </div>
      </div>
    )
  }

  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Feedback Forms</h1>
          <p className="text-sm sm:text-base text-gray-500">Create embeddable forms to collect customer feedback</p>
        </div>
        <button
          onClick={() => setShowWizard(true)}
          className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
        >
          <Plus size={18} />
          Create Form
        </button>
      </div>

      {/* Info banner */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
        <h4 className="font-medium text-blue-900 mb-2 flex items-center gap-2">
          <Eye size={16} /> Typeform-style Feedback Collection
        </h4>
        <ul className="text-sm text-blue-800 space-y-1 list-disc list-inside">
          <li>Create multiple forms for different purposes (website, app, support, etc.)</li>
          <li>Each form has its own unique URL and embed code</li>
          <li>Assign categories to route feedback automatically</li>
          <li>All submissions go through AI enrichment (sentiment, personas, etc.)</li>
        </ul>
      </div>

      {/* Forms list */}
      <FormsListContent
        isLoading={isLoading}
        forms={formsData?.forms}
        onEdit={setEditingForm}
        onDelete={handleDelete}
        onToggle={(formId, enabled) => toggleMutation.mutate({ formId, enabled })}
        onCreateNew={() => setShowWizard(true)}
        apiEndpoint={apiEndpoint}
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
      {(templateConfig || editingForm) && (
        <FormEditor
          form={editingForm}
          initialConfig={templateConfig}
          categories={categories}
          onSave={(form) => saveMutation.mutate(form)}
          onCancel={() => {
            setEditingForm(null)
            setTemplateConfig(null)
          }}
          isSaving={saveMutation.isPending}
        />
      )}

      <ConfirmModal
        isOpen={deleteFormId !== null}
        title="Delete Form"
        message="Are you sure you want to delete this form? This action cannot be undone."
        confirmLabel="Delete"
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
