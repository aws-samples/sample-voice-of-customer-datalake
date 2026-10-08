/**
 * @fileoverview The create/edit dialog for one feedback form: a tab strip over
 * the settings, category-routing, validation-link and theme panels.
 * @module pages/FeedbackForms/FormEditor
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2, Palette, Settings2, Save, Link2, Tag } from 'lucide-react'
import clsx from 'clsx'
import type { LucideIcon } from 'lucide-react'
import type { FeedbackForm } from '../../api/types'
import { defaultFormConfig } from './formTemplates'
import ValidationLinkPicker from './ValidationLinkPicker'
import type { ValidationLink } from './ValidationLinkPicker'
import DialogClose from '../../components/DialogClose/DialogClose'
import ModalShell from '../../components/ModalShell/ModalShell'
import { saveIgnoringFailure, useSnapshotGuard } from '../../components/UnsavedChangesGuard/useSnapshotGuard'
import { CategoryPanel, SettingsPanel, ThemePanel } from './FormEditorPanels'
import type { EditorCategory } from './FormEditorPanels'

type FormConfig = Omit<FeedbackForm, 'form_id' | 'created_at' | 'updated_at'>
export type FormConfigWithId = FormConfig & { form_id?: string }

type EditorTabId = 'settings' | 'category' | 'validation' | 'theme'

/** One entry in the editor's tab strip. */
interface EditorTab {
  readonly id: EditorTabId
  readonly label: string
  readonly shortLabel: string
  readonly icon: LucideIcon
}

interface FormEditorProps {
  readonly form: FeedbackForm | null
  readonly initialConfig?: FormConfig | null
  readonly categories: ReadonlyArray<EditorCategory>
  /** The host's save; resolves on success, rejects on failure (the guard waits for it). */
  readonly onSave: (form: FormConfigWithId) => Promise<unknown>
  readonly onCancel: () => void
  readonly isSaving?: boolean
  /** False before the API endpoint is configured — the validation-link picker
   *  reads projects, so it must not fire a request without one. */
  readonly validationPickerEnabled: boolean
}

function getInitialFormData(form: FeedbackForm | null, initialConfig: FormConfig | null | undefined): FormConfigWithId {
  if (form) return { ...form }
  if (initialConfig) return { ...initialConfig }
  return { ...defaultFormConfig }
}

/**
 * The link fields as the picker's controlled selects need them: '' rather than
 * undefined, so a record persisted before these fields existed still renders.
 * A module-level helper rather than inline JSX, to keep `FormEditor` under the
 * repo's complexity ceiling.
 */
function toValidationLink(formData: FormConfigWithId): ValidationLink {
  return {
    project_id: formData.project_id ?? '',
    document_id: formData.document_id ?? '',
  }
}

function getSaveButtonText(isSaving: boolean, isEditing: boolean, t: (key: string) => string): string {
  if (isSaving) return isEditing ? t('editor.saving') : t('editor.creating')
  return isEditing ? t('editor.saveChanges') : t('editor.createForm')
}

/**
 * The editor's tab strip. Extracted from `FormEditor` when the fourth tab
 * pushed that function past the repo's complexity ceiling.
 */
function EditorTabBar({ activeTab, onSelect }: Readonly<{
  activeTab: EditorTabId
  onSelect: (tab: EditorTabId) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  // Annotated, not inferred: with `id` typed as EditorTabId, `onSelect(tab.id)`
  // typechecks directly, so no runtime narrowing guard is needed and a mistyped
  // id fails to compile instead of rendering a button that silently does
  // nothing. All four labels come from the catalogues — the keys already exist
  // in all eight locales, and a half-translated tab strip reads worse than
  // either extreme.
  const tabs: readonly EditorTab[] = [
    { id: 'settings', label: t('editor.tabs.formSettings'), shortLabel: t('editor.tabs.settings'), icon: Settings2 },
    { id: 'category', label: t('editor.tabs.categoryRouting'), shortLabel: t('editor.tabs.category'), icon: Tag },
    { id: 'validation', label: t('editor.tabs.validates'), shortLabel: t('editor.tabs.validatesShort'), icon: Link2 },
    { id: 'theme', label: t('editor.tabs.theme'), shortLabel: t('editor.tabs.theme'), icon: Palette },
  ]
  return (
    <div className="tabs-rail !mb-0 px-3 sm:px-4 pt-3 sm:pt-4">
      <div className="tabs-track" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          onClick={() => onSelect(tab.id)}
          className={clsx('tab', activeTab === tab.id && 'tab-active')}
        >
          <tab.icon size={14} aria-hidden="true" />
          <span className="hidden sm:inline">{tab.label}</span>
          <span className="sm:hidden">{tab.shortLabel}</span>
        </button>
      ))}
      </div>
    </div>
  )
}

export default function FormEditor({ form, initialConfig, categories, onSave, onCancel, isSaving, validationPickerEnabled }: FormEditorProps) {
  const { t } = useTranslation('feedbackForms')
  const titleId = useId()
  const fieldId = useId()
  const [activeTab, setActiveTab] = useState<EditorTabId>('settings')
  const [formData, setFormData] = useState<FormConfigWithId>(() => getInitialFormData(form, initialConfig))
  // Every way out (Cancel, the X, Escape, the backdrop) asks first when there are edits (E2E F6).
  const { close, dialog: guardDialog } = useSnapshotGuard({ value: formData, onSave: () => onSave(formData), onClose: onCancel })

  const update = (patch: Partial<FormConfig>) => setFormData({ ...formData, ...patch })

  return (
    // ModalShell: role="dialog", a name, focus trap and Escape (= Cancel). Not
    // dismissable while a save is in flight, so the request cannot be orphaned.
    <ModalShell
      isOpen
      onClose={close}
      ariaLabelledBy={titleId}
      dismissable={!isSaving}
      panelClassName="max-w-4xl max-h-[90vh]"
    >
        {/* Header */}
        <div className="dialog-header justify-between">
          <h2 id={titleId} className="dialog-title">
            {form ? t('editor.editTitle') : t('editor.createTitle')}
          </h2>
          <DialogClose onClick={close} className="flex-shrink-0" />
        </div>

        <EditorTabBar activeTab={activeTab} onSelect={setActiveTab} />

        {/* Content */}
        <div className="dialog-body">
          {activeTab === 'settings' && <SettingsPanel formData={formData} onChange={update} fieldId={fieldId} />}

          {activeTab === 'category' && <CategoryPanel formData={formData} onChange={update} fieldId={fieldId} categories={categories} />}

          {activeTab === 'validation' && (
            <ValidationLinkPicker
              value={toValidationLink(formData)}
              onChange={(link) => update(link)}
              enabled={validationPickerEnabled}
            />
          )}

          {activeTab === 'theme' && <ThemePanel formData={formData} onChange={update} fieldId={fieldId} />}
        </div>

        {/* Footer */}
        <div className="dialog-footer flex-col-reverse sm:flex-row items-stretch sm:items-center">
          <button onClick={close} className="btn btn-secondary" disabled={isSaving}>
            {t('editor.cancel')}
          </button>
          <button
            onClick={() => saveIgnoringFailure(() => onSave(formData))}
            disabled={isSaving}
            className="btn btn-primary"
          >
            {isSaving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
            {getSaveButtonText(isSaving ?? false, !!form, t)}
          </button>
        </div>
        {guardDialog}
    </ModalShell>
  )
}
