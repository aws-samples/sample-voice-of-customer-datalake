/**
 * @fileoverview Form editor modal for creating/editing feedback forms.
 * @module pages/FeedbackForms/FormEditor
 */

import clsx from 'clsx'
import {
  Loader2, Palette, Settings2, Save, X,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { defaultFormConfig } from './formTemplates'
import type { FeedbackForm } from '../../api/types'

type FormConfig = Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>
type FormConfigWithId = FormConfig & { form_id?: string }

interface FormEditorProps {
  readonly form: FeedbackForm | null
  readonly initialConfig?: FormConfig | null
  readonly categories: ReadonlyArray<{
    id: string;
    name: string;
    subcategories: ReadonlyArray<{
      id: string;
      name: string
    }>
  }>
  readonly onSave: (form: FormConfigWithId) => void
  readonly onCancel: () => void
  readonly isSaving?: boolean
}

function getInitialFormData(form: FeedbackForm | null, initialConfig: FormConfig | null | undefined): FormConfigWithId {
  if (form) return { ...form }
  if (initialConfig) return { ...initialConfig }
  return { ...defaultFormConfig }
}

function getSaveButtonText(isSaving: boolean, isEditing: boolean, t: (key: string) => string): string {
  if (isSaving) return isEditing ? t('editor.saving') : t('editor.creating')
  return isEditing ? t('editor.saveChanges') : t('editor.createForm')
}

export default function FormEditor({
  form, initialConfig, categories, onSave, onCancel, isSaving,
}: FormEditorProps) {
  const { t } = useTranslation('feedbackForms')
  const [activeTab, setActiveTab] = useState<'settings' | 'theme' | 'category'>('settings')
  const [formData, setFormData] = useState<FormConfigWithId>(() => getInitialFormData(form, initialConfig))

  const selectedCategory = categories.find((c) => c.id === formData.category)

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-3 sm:p-4 border-b">
          <h2 className="text-base sm:text-lg font-semibold truncate pr-2">
            {form ? t('editor.editTitle') : t('editor.createTitle')}
          </h2>
          <button onClick={onCancel} className="p-2 hover:bg-gray-100 rounded-lg flex-shrink-0"><X size={20} /></button>
        </div>
        <div className="flex gap-1 sm:gap-2 px-3 sm:px-4 pt-3 sm:pt-4 border-b border-gray-200 overflow-x-auto">
          {([
            {
              id: 'settings' as const,
              label: t('editor.tabs.formSettings'),
              shortLabel: t('editor.tabs.settings'),
              icon: Settings2,
            },
            {
              id: 'category' as const,
              label: t('editor.tabs.categoryRouting'),
              shortLabel: t('editor.tabs.category'),
              icon: Settings2,
            },
            {
              id: 'theme' as const,
              label: t('editor.tabs.theme'),
              shortLabel: t('editor.tabs.theme'),
              icon: Palette,
            },
          ]).map((tab) => (
            <button key={tab.id} onClick={() => setActiveTab(tab.id)}
              className={clsx('flex items-center gap-1 sm:gap-2 px-2 sm:px-4 py-2 border-b-2 -mb-px transition-colors whitespace-nowrap text-sm',
                activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700')}>
              <tab.icon size={16} />
              <span className="hidden sm:inline">{tab.label}</span>
              <span className="sm:hidden">{tab.shortLabel}</span>
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-auto p-3 sm:p-4">
          {activeTab === 'settings' && <SettingsTab formData={formData} setFormData={setFormData} />}
          {activeTab === 'category' && <CategoryTab formData={formData} setFormData={setFormData} categories={categories} selectedCategory={selectedCategory} />}
          {activeTab === 'theme' && <ThemeTab formData={formData} setFormData={setFormData} />}
        </div>
        <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center justify-end gap-2 sm:gap-3 p-3 sm:p-4 border-t bg-gray-50">
          <button onClick={onCancel} className="btn btn-secondary" disabled={isSaving}>{t('editor.cancel')}</button>
          <button onClick={() => onSave(formData)} disabled={isSaving}
            className="btn btn-primary flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed">
            {isSaving === true ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {getSaveButtonText(isSaving ?? false, !!form, t)}
          </button>
        </div>
      </div>
    </div>
  )
}

function SettingsTab({
  formData, setFormData,
}: {
  readonly formData: FormConfigWithId;
  readonly setFormData: (d: FormConfigWithId) => void
}) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
      <div className="space-y-3 sm:space-y-4">
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.formName')}</label>
          <input type="text" value={formData.name} onChange={(e) => setFormData({
            ...formData,
            name: e.target.value,
          })} placeholder={t('editor.formNamePlaceholder')} className="input" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.formTitle')}</label>
          <input type="text" value={formData.title} onChange={(e) => setFormData({
            ...formData,
            title: e.target.value,
          })} className="input" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.description')}</label>
          <textarea value={formData.description} onChange={(e) => setFormData({
            ...formData,
            description: e.target.value,
          })} className="input min-h-[80px]" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.question')}</label>
          <input type="text" value={formData.question} onChange={(e) => setFormData({
            ...formData,
            question: e.target.value,
          })} className="input" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.placeholderText')}</label>
          <input type="text" value={formData.placeholder} onChange={(e) => setFormData({
            ...formData,
            placeholder: e.target.value,
          })} className="input" /></div>
      </div>
      <div className="space-y-3 sm:space-y-4">
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.submitButtonText')}</label>
          <input type="text" value={formData.submit_button_text} onChange={(e) => setFormData({
            ...formData,
            submit_button_text: e.target.value,
          })} className="input" /></div>
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.successMessage')}</label>
          <input type="text" value={formData.success_message} onChange={(e) => setFormData({
            ...formData,
            success_message: e.target.value,
          })} className="input" /></div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={formData.rating_enabled} onChange={(e) => setFormData({
              ...formData,
              rating_enabled: e.target.checked,
            })} className="rounded border-gray-300 text-blue-600" />
            <span className="text-sm">{t('editor.enableRating')}</span>
          </label>
          {formData.rating_enabled ? <select value={formData.rating_type} onChange={(e) => {
            const val = e.target.value; if (val === 'stars' || val === 'numeric' || val === 'emoji') setFormData({
              ...formData,
              rating_type: val,
            })
          }} className="input w-auto">
            <option value="stars">{t('editor.ratingStars')}</option>
            <option value="numeric">{t('editor.ratingNumeric')}</option>
            <option value="emoji">{t('editor.ratingEmoji')}</option>
          </select> : null}
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={formData.collect_name} onChange={(e) => setFormData({
              ...formData,
              collect_name: e.target.checked,
            })} className="rounded border-gray-300 text-blue-600" />
            <span className="text-sm">{t('editor.collectName')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={formData.collect_email} onChange={(e) => setFormData({
              ...formData,
              collect_email: e.target.checked,
            })} className="rounded border-gray-300 text-blue-600" />
            <span className="text-sm">{t('editor.collectEmail')}</span>
          </label>
        </div>
      </div>
    </div>
  )
}

function CategoryTab({
  formData, setFormData, categories, selectedCategory,
}: {
  readonly formData: FormConfigWithId;
  readonly setFormData: (d: FormConfigWithId) => void
  readonly categories: ReadonlyArray<{
    id: string;
    name: string;
    subcategories: ReadonlyArray<{
      id: string;
      name: string
    }>
  }>
  readonly selectedCategory: {
    id: string;
    name: string;
    subcategories: ReadonlyArray<{
      id: string;
      name: string
    }>
  } | undefined
}) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 sm:p-4">
        <h4 className="font-medium text-blue-900 mb-2 text-sm sm:text-base">{t('editor.categoryRoutingTitle')}</h4>
        <p className="text-xs sm:text-sm text-blue-800">{t('editor.categoryRoutingDescription')}</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.categoryLabel')}</label>
          <select value={formData.category} onChange={(e) => setFormData({
            ...formData,
            category: e.target.value,
            subcategory: '',
          })} className="input">
            <option value="">{t('editor.selectCategory')}</option>
            {categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.name}</option>)}
          </select>
          <p className="text-xs text-gray-500 mt-1">{t('editor.categoryHint')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.subcategoryLabel')}</label>
          <select value={formData.subcategory} onChange={(e) => setFormData({
            ...formData,
            subcategory: e.target.value,
          })} className="input" disabled={!selectedCategory}>
            <option value="">{t('editor.selectSubcategory')}</option>
            {selectedCategory?.subcategories.map((sub) => <option key={sub.id} value={sub.id}>{sub.name}</option>)}
          </select>
        </div>
      </div>
      {formData.category === '' ? null : <div className="p-3 sm:p-4 bg-gray-50 rounded-lg">
        <p className="text-sm text-gray-700"><strong>{t('editor.previewLabel')}</strong> {t('editor.previewTagged')}</p>
        <p className="mt-2 font-mono text-xs sm:text-sm bg-white px-3 py-2 rounded border inline-block break-all">
          category: &quot;{formData.category}&quot;{formData.subcategory === '' ? null : <>, subcategory: &quot;{formData.subcategory}&quot;</>}
        </p>
      </div>}
    </div>
  )
}

function ThemeTab({
  formData, setFormData,
}: {
  readonly formData: FormConfigWithId;
  readonly setFormData: (d: FormConfigWithId) => void
}) {
  const { t } = useTranslation('feedbackForms')
  const updateTheme = (field: string, value: string) => setFormData({
    ...formData,
    theme: {
      ...formData.theme,
      [field]: value,
    },
  })
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
      <div className="space-y-3 sm:space-y-4">
        <ColorField label={t('editor.primaryColor')} value={formData.theme.primary_color} onChange={(v) => updateTheme('primary_color', v)} />
        <ColorField label={t('editor.backgroundColor')} value={formData.theme.background_color} onChange={(v) => updateTheme('background_color', v)} />
        <ColorField label={t('editor.textColor')} value={formData.theme.text_color} onChange={(v) => updateTheme('text_color', v)} />
        <div><label className="block text-sm font-medium text-gray-700 mb-1">{t('editor.borderRadius')}</label>
          <input type="text" value={formData.theme.border_radius} onChange={(e) => updateTheme('border_radius', e.target.value)} placeholder="8px" className="input" /></div>
      </div>
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">{t('editor.preview')}</label>
        <div className="relative overflow-hidden border" style={{
          backgroundColor: formData.theme.background_color,
          color: formData.theme.text_color,
          borderRadius: formData.theme.border_radius,
          minHeight: '240px',
        }}>
          <div className="absolute top-0 left-0 h-1 transition-all" style={{
            backgroundColor: formData.theme.primary_color,
            width: '33%',
          }} />
          <div className="flex flex-col items-center justify-center text-center p-4 sm:p-6 h-full min-h-[240px]">
            <h3 className="text-lg sm:text-xl font-bold mb-2 line-clamp-2">{formData.title}</h3>
            <p className="text-xs sm:text-sm mb-4 opacity-70 max-w-xs line-clamp-2">{formData.description}</p>
            <button className="px-4 sm:px-5 py-2 text-white font-medium text-sm" style={{
              backgroundColor: formData.theme.primary_color,
              borderRadius: formData.theme.border_radius,
            }}>Start →</button>
          </div>
        </div>
      </div>
    </div>
  )
}

function ColorField({
  label, value, onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (v: string) => void
}) {
  return (
    <div><label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <div className="flex items-center gap-2">
        <input type="color" value={value} onChange={(e) => onChange(e.target.value)} className="w-10 h-10 rounded border cursor-pointer flex-shrink-0" />
        <input type="text" value={value} onChange={(e) => onChange(e.target.value)} className="input flex-1 min-w-0" />
      </div>
    </div>
  )
}
