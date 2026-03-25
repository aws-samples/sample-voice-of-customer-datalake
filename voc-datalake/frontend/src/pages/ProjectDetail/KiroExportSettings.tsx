/**
 * KiroExportSettings - Configure context for "Copy to Kiro" exports
 */
import { useState, useMemo } from 'react'
import { Sparkles, Settings, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { KiroExportSettingsProps } from './types'

const DEFAULT_PROMPT = `# Kiro Implementation Context

## Project Overview
Implement the following PRD for [Your Project Name].

## Tech Stack
- Frontend: React + TypeScript + Tailwind CSS
- Backend: [Your backend stack]
- Database: [Your database]

## Coding Standards
- Follow existing code patterns in the codebase
- Use TypeScript strict mode
- Write unit tests for new functionality
- Follow the project's ESLint configuration

## Implementation Notes
- [Add specific implementation guidance here]
- [Reference relevant files or patterns]
- [Note any constraints or requirements]`

// Empty state component
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
function PromptEditor({ prompt, saved, onPromptChange, onSave, onCancel, onUseDefault }: Readonly<{
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
          placeholder={DEFAULT_PROMPT}
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

export default function KiroExportSettings({ project, onSave }: Readonly<KiroExportSettingsProps>) {
  const initialPrompt = useMemo(() => project.kiro_export_prompt ?? '', [project.kiro_export_prompt])
  const { t } = useTranslation('projectDetail')
  
  const [prompt, setPrompt] = useState(initialPrompt)
  const [isEditing, setIsEditing] = useState(false)
  const [saved, setSaved] = useState(false)

  const handleSave = () => {
    onSave(prompt)
    setIsEditing(false)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleCancel = () => {
    setIsEditing(false)
    setPrompt(project.kiro_export_prompt ?? '')
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
          onUseDefault={() => setPrompt(DEFAULT_PROMPT)}
        />
      )
    }
    if (prompt) {
      return <PromptPreview prompt={prompt} />
    }
    return <EmptyState />
  }

  return (
    <div className="bg-white rounded-xl p-6 border">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-purple-100 rounded-lg flex items-center justify-center">
            <Sparkles size={20} className="text-purple-600" />
          </div>
          <div>
            <h3 className="font-semibold">{t('kiroExport.title')}</h3>
            <p className="text-sm text-gray-500">{t('kiroExport.description')}</p>
          </div>
        </div>
        {!isEditing && (
          <button
            onClick={() => setIsEditing(true)}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-purple-600 hover:bg-purple-50 rounded-lg"
          >
            <Settings size={16} />
            {prompt ? t('kiroExport.edit') : t('kiroExport.configure')}
          </button>
        )}
      </div>
      {renderContent()}
    </div>
  )
}
