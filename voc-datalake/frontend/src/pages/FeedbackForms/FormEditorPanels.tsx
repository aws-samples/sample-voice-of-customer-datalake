/**
 * @fileoverview The form editor's Settings, Category routing and Theme panels.
 * @module pages/FeedbackForms/FormEditorPanels
 */

import type { ChangeEvent } from 'react'
import { useTranslation } from 'react-i18next'
import type { FeedbackForm } from '../../api/types'
import DimensionDefaultsSection from '../../components/DimensionFields/DimensionDefaultsSection'

type FormConfig = Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>

/** What every panel gets: the draft, a merge-patch setter, and the editor's id prefix. */
interface PanelProps {
  readonly formData: FormConfig
  readonly onChange: (patch: Partial<FormConfig>) => void
  readonly fieldId: string
}

export interface EditorCategory {
  id: string
  name: string
  subcategories: ReadonlyArray<{ id: string; name: string }>
}

/** What every labelled string field takes. */
type FieldProps = Readonly<{
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}>

/** The field label every panel control sits under. */
function FieldLabel({ htmlFor, children }: Readonly<{ htmlFor: string; children: string }>) {
  return <label htmlFor={htmlFor} className="block text-sm font-medium text-text mb-1">{children}</label>
}

/** A labelled single-line text input. */
function TextField({ id, label, value, placeholder, onChange }: FieldProps & Readonly<{ placeholder?: string }>) {
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <input id={id} type="text" value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className="input" />
    </div>
  )
}

/**
 * A colour field: the native picker (named by the visible label) plus a text input
 * for typing a hex value (named by aria-label, since one label can name one control).
 * Edits the CUSTOMER's form theme, so the swatch shows their colour, not a token.
 */
function ColorField({ id, label, value, onChange }: FieldProps) {
  const handleChange = (e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)
  return (
    <div>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          value={value}
          onChange={handleChange}
          className="w-10 h-10 rounded-sm border border-border bg-bg-elevated cursor-pointer flex-shrink-0 focus-ring"
        />
        <input aria-label={label} type="text" value={value} onChange={handleChange} className="input flex-1 min-w-0 font-mono" />
      </div>
    </div>
  )
}

export function SettingsPanel({ formData, onChange, fieldId }: PanelProps) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
      <div className="space-y-3 sm:space-y-4">
        <TextField id={`${fieldId}-formName`} label={t('editor.formName')} value={formData.name} placeholder={t('editor.formNamePlaceholder')} onChange={(value) => onChange({ name: value })} />
        <TextField id={`${fieldId}-formTitle`} label={t('editor.formTitle')} value={formData.title} onChange={(value) => onChange({ title: value })} />
        <div>
          <FieldLabel htmlFor={`${fieldId}-description`}>{t('editor.description')}</FieldLabel>
          <textarea
            id={`${fieldId}-description`}
            value={formData.description}
            onChange={(e) => onChange({ description: e.target.value })}
            className="input min-h-[80px]"
          />
        </div>
        <TextField id={`${fieldId}-question`} label={t('editor.question')} value={formData.question} onChange={(value) => onChange({ question: value })} />
        <TextField id={`${fieldId}-placeholderText`} label={t('editor.placeholderText')} value={formData.placeholder} onChange={(value) => onChange({ placeholder: value })} />
      </div>
      <div className="space-y-3 sm:space-y-4">
        <TextField id={`${fieldId}-submitButtonText`} label={t('editor.submitButtonText')} value={formData.submit_button_text} onChange={(value) => onChange({ submit_button_text: value })} />
        <TextField id={`${fieldId}-successMessage`} label={t('editor.successMessage')} value={formData.success_message} onChange={(value) => onChange({ success_message: value })} />
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formData.rating_enabled}
              onChange={(e) => onChange({ rating_enabled: e.target.checked })}
              className="rounded-sm accent-accent"
            />
            <span className="text-sm text-text">{t('editor.enableRating')}</span>
          </label>
          {formData.rating_enabled && (
            <select
              value={formData.rating_type}
              onChange={(e) => {
                const val = e.target.value
                if (val === 'stars' || val === 'numeric' || val === 'emoji') {
                  onChange({ rating_type: val })
                }
              }}
              aria-label={t('card.ratingType')}
              className="select w-auto"
            >
              <option value="stars">{t('editor.ratingStars')}</option>
              <option value="numeric">{t('editor.ratingNumeric')}</option>
              <option value="emoji">{t('editor.ratingEmoji')}</option>
            </select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3 sm:gap-4">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formData.collect_name}
              onChange={(e) => onChange({ collect_name: e.target.checked })}
              className="rounded-sm accent-accent"
            />
            <span className="text-sm text-text">{t('editor.collectName')}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={formData.collect_email}
              onChange={(e) => onChange({ collect_email: e.target.checked })}
              className="rounded-sm accent-accent"
            />
            <span className="text-sm text-text">{t('editor.collectEmail')}</span>
          </label>
        </div>
      </div>
    </div>
  )
}

export function CategoryPanel({ formData, onChange, fieldId, categories }: PanelProps & {
  readonly categories: ReadonlyArray<EditorCategory>
}) {
  const { t } = useTranslation('feedbackForms')
  const selectedCategory = categories.find(c => c.id === formData.category)
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="bg-info-subtle border border-info/30 rounded-lg p-3 sm:p-4">
        <h3 className="font-medium text-info mb-2 text-sm sm:text-base">{t('editor.categoryRoutingTitle')}</h3>
        <p className="text-xs sm:text-sm text-text">{t('editor.categoryRoutingDescription')}</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <div>
          <FieldLabel htmlFor={`${fieldId}-categoryLabel`}>{t('editor.categoryLabel')}</FieldLabel>
          <select
            id={`${fieldId}-categoryLabel`}
            value={formData.category}
            onChange={(e) => onChange({ category: e.target.value, subcategory: '' })}
            className="select"
          >
            <option value="">{t('editor.selectCategory')}</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>{cat.name}</option>
            ))}
          </select>
          <p className="text-xs text-muted mt-1">{t('editor.categoryHint')}</p>
        </div>

        <div>
          <FieldLabel htmlFor={`${fieldId}-subcategoryLabel`}>{t('editor.subcategoryLabel')}</FieldLabel>
          <select
            id={`${fieldId}-subcategoryLabel`}
            value={formData.subcategory}
            onChange={(e) => onChange({ subcategory: e.target.value })}
            className="select"
            disabled={!selectedCategory}
          >
            <option value="">{t('editor.selectSubcategory')}</option>
            {selectedCategory?.subcategories.map(sub => (
              <option key={sub.id} value={sub.id}>{sub.name}</option>
            ))}
          </select>
        </div>
      </div>

      {formData.category && (
        <div className="p-3 sm:p-4 bg-bg-accent border border-border rounded-lg">
          <p className="text-sm text-text">
            <strong>{t('editor.previewLabel')}</strong> {t('editor.previewTagged')}
          </p>
          <p className="mt-2 font-mono text-xs sm:text-sm bg-bg-elevated text-text px-3 py-2 rounded-sm border border-border inline-block break-all">
            category: "{formData.category}"
            {formData.subcategory && <>, subcategory: "{formData.subcategory}"</>}
          </p>
        </div>
      )}

      <DimensionDefaultsSection
        dimensionDefaults={formData.dimension_defaults}
        tags={formData.tags}
        onChange={onChange}
        hint={<>{t('editor.dimensionsHint')} <code className="font-mono">{"dimensions: { product: 'mobile_app' }"}</code></>}
      />
    </div>
  )
}

export function ThemePanel({ formData, onChange, fieldId }: PanelProps) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
      <div className="space-y-3 sm:space-y-4">
        <ColorField
          id={`${fieldId}-primaryColor`}
          label={t('editor.primaryColor')}
          value={formData.theme.primary_color}
          onChange={(value) => onChange({ theme: { ...formData.theme, primary_color: value } })}
        />
        <ColorField
          id={`${fieldId}-backgroundColor`}
          label={t('editor.backgroundColor')}
          value={formData.theme.background_color}
          onChange={(value) => onChange({ theme: { ...formData.theme, background_color: value } })}
        />
        <ColorField
          id={`${fieldId}-textColor`}
          label={t('editor.textColor')}
          value={formData.theme.text_color}
          onChange={(value) => onChange({ theme: { ...formData.theme, text_color: value } })}
        />
        <div>
          <FieldLabel htmlFor={`${fieldId}-borderRadius`}>{t('editor.borderRadius')}</FieldLabel>
          <input
            id={`${fieldId}-borderRadius`}
            type="text"
            value={formData.theme.border_radius}
            onChange={(e) => onChange({ theme: { ...formData.theme, border_radius: e.target.value } })}
            placeholder="8px"
            className="input"
          />
        </div>
      </div>
      {/* Preview */}
      <div>
        <p className="block text-sm font-medium text-text mb-2">{t('editor.preview')}</p>
        <div
          className="relative overflow-hidden border border-border"
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
            {/* Colour set explicitly: the base stylesheet paints every heading
                `text-text-strong`, which overrode the customer's text colour and
                left the title near-invisible (white on white) in Kiro Dark. */}
            <h3 className="text-lg sm:text-xl font-bold mb-2 line-clamp-2" style={{ color: formData.theme.text_color }}>{formData.title}</h3>
            <p className="text-xs sm:text-sm mb-4 opacity-70 max-w-xs line-clamp-2">{formData.description}</p>
            <button
              className="px-4 sm:px-5 py-2 text-white font-medium text-sm"
              style={{ backgroundColor: formData.theme.primary_color, borderRadius: formData.theme.border_radius }}
            >
              {t('editor.startButton')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
