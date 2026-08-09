/**
 * KiroExportSettings - editor for the per-project export-prompt template.
 *
 * The template is shared config for BOTH Kiro handoff paths, not just one:
 * the backend's `_build_steering_file` injects it into the autoseed payload,
 * and `DocumentExportMenu` prepends it to a single-document "Copy to Kiro".
 *
 * Renders as a SECTION, not a card — it has no bg/border/padding of its own and
 * expects an enclosing card (the Export card in McpAccessTab) to supply them,
 * and to own the h3 above this section's h4.
 */
import {
  Sparkles, Settings, Check,
} from 'lucide-react'
import {
  useState,
} from 'react'
import { useTranslation } from 'react-i18next'
import type { KiroExportSettingsProps } from './types'

// Empty state component — shown when there is no stored override and no default
// available yet (e.g. list-route responses that omit kiro_default_export_prompt).
function EmptyState() {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="text-center py-6 bg-gray-50 rounded-lg border-2 border-dashed border-gray-200">
      <Sparkles size={24} className="mx-auto text-gray-400 mb-2" />
      <p className="text-gray-500 text-sm">{t('kiroExport.noPrompt')}</p>
      <p className="text-gray-400 text-xs mt-1">{t('kiroExport.noPromptHint')}</p>
    </div>
  )
}

// Preview component
function PromptPreview({ prompt }: Readonly<{ prompt: string }>) {
  return (
    <div className="bg-gray-50 rounded-lg p-4">
      <pre className="text-sm text-gray-600 whitespace-pre-wrap font-mono max-h-32 overflow-y-auto">
        {prompt.slice(0, 300)}{prompt.length > 300 ? '...' : ''}
      </pre>
    </div>
  )
}

// Editor component
function PromptEditor({
  prompt, saved, onPromptChange, onSave, onCancel, onUseDefault,
}: Readonly<{
  prompt: string
  saved: boolean
  onPromptChange: (value: string) => void
  onSave: () => void
  onCancel: () => void
  onUseDefault: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('kiroExport.templateLabel')}
        </label>
        <p className="text-xs text-gray-500 mb-2">
          {t('kiroExport.templateHint')}
        </p>
        <textarea
          value={prompt}
          onChange={(e) => onPromptChange(e.target.value)}
          rows={12}
          className="w-full px-3 py-2 border rounded-lg font-mono text-sm focus:ring-2 focus:ring-purple-500 focus:border-purple-500"
        />
      </div>
      <div className="flex items-center justify-between">
        <button onClick={onUseDefault} className="text-sm text-gray-500 hover:text-gray-700">
          {t('kiroExport.useDefault')}
        </button>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-gray-600 hover:bg-gray-100 rounded-lg">
            {t('kiroExport.cancel')}
          </button>
          <button
            onClick={onSave}
            className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700"
          >
            {saved ? <Check size={16} /> : <Sparkles size={16} />}
            {saved ? t('kiroExport.saved') : t('kiroExport.save')}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function KiroExportSettings({
  project, onSave,
}: Readonly<KiroExportSettingsProps>) {
  const storedPrompt = project.kiro_export_prompt ?? ''
  const defaultPrompt = project.kiro_default_export_prompt ?? ''
  const { t } = useTranslation('projectDetail')

  // The effective prompt is the stored value if non-empty, else the default.
  const effectivePrompt = storedPrompt !== '' ? storedPrompt : defaultPrompt

  const [prompt, setPrompt] = useState(storedPrompt)
  const [isEditing, setIsEditing] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    // Trim before saving so a whitespace-only entry is stored as '' (empty),
    // keeping the project following the default and avoiding a misleading
    // "Edit" button label with a visually blank preview.
    onSave(prompt.trim())
    setIsEditing(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleCancel = () => {
    setIsEditing(false)
    setPrompt(storedPrompt)
  }

  // Sync the editor with the latest stored value when opening it.
  // This ensures the textarea shows the freshest server state even if the
  // parent refetched the project after mount (e.g. polling or post-save).
  const handleEdit = () => {
    setPrompt(storedPrompt)
    setIsEditing(true)
  }

  const renderContent = () => {
    if (isEditing) {
      return (
        <PromptEditor
          prompt={prompt}
          saved={saved}
          onPromptChange={setPrompt}
          onSave={handleSave}
          onCancel={handleCancel}
          onUseDefault={() => setPrompt('')}
        />
      )
    }
    if (effectivePrompt !== '') {
      return <PromptPreview prompt={effectivePrompt} />
    }
    return <EmptyState />
  }

  // Deliberately carries NO card chrome (no bg/border/padding): this renders as
  // a section INSIDE the Export card, which supplies them. A wrapper here would
  // nest a card in a card, which is why an earlier revision left it as a third
  // sibling card and split the Export grouping in two.
  // Heading is h4 with CollapsibleSection's class string — the established
  // nested-section idiom in this tab — because the enclosing card owns the h3.
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-purple-100 rounded-lg flex items-center justify-center flex-shrink-0">
            <Sparkles size={16} className="text-purple-600" />
          </div>
          <div>
            <h4 className="font-medium text-sm text-gray-700">{t('kiroExport.title')}</h4>
            <p className="text-sm text-gray-500">{t('kiroExport.description')}</p>
          </div>
        </div>
        {!isEditing && (
          <button
            onClick={handleEdit}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-purple-600 hover:bg-purple-50 rounded-lg"
          >
            <Settings size={16} />
            {storedPrompt === '' ? t('kiroExport.configure') : t('kiroExport.edit')}
          </button>
        )}
      </div>
      {renderContent()}
    </div>
  )
}
