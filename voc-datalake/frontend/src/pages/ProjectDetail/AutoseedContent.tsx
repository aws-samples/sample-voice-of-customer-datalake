/**
 * AutoseedContent - Inner content for the Kiro Autoseed collapsible section.
 * Displays the generated curl prompt for seeding a Kiro workspace.
 *
 * The curlUrl is built at the tab level from the shared persona/document
 * selection (held in McpAccessTab) and passed in as a prop, so this component
 * does not need its own pickers — the selection that drives Card 1 (Export) and
 * Card 2 (MCP Access) is a single shared state rendered once above both cards.
 */
import {
  Copy, Check,
} from 'lucide-react'
import {
  useState, useCallback,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useConfigStore } from '../../store/configStore'
import { generateKiroPrompt } from './generateKiroPrompt'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

interface AutoseedContentProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  /** Pre-built autoseed curl URL from the shared selection held in McpAccessTab. */
  readonly curlUrl: string
}

export default function AutoseedContent({
  personas, documents, curlUrl,
}: AutoseedContentProps) {
  const { config } = useConfigStore()
  const { t } = useTranslation('projectDetail')
  const [copied, setCopied] = useState(false)

  const kiroPrompt = generateKiroPrompt(curlUrl)

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(kiroPrompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [kiroPrompt])

  const isEmpty = personas.length === 0 && documents.length === 0

  if (isEmpty) {
    return (
      <p className="text-sm text-gray-400 text-center py-2">
        {t('autoseed.generateFirst')}
      </p>
    )
  }

  const hasSelection = curlUrl.length > 0

  return (
    <div>
      <p className="text-sm text-gray-500 mb-3">{t('autoseed.description')}</p>

      {/* Generated prompt */}
      <div className="mt-2">
        <div className="flex items-center justify-between mb-2">
          <p className="text-sm font-medium text-gray-700">{t('autoseed.generatedPrompt')}</p>
          <button
            onClick={() => void handleCopy()}
            disabled={config.apiEndpoint === '' || !hasSelection}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {copied ? <Check size={16} /> : <Copy size={16} />}
            {copied ? t('mcp.copied') : t('autoseed.copyKiroPrompt')}
          </button>
        </div>
        <div className="bg-gray-900 rounded-lg p-4 max-h-48 overflow-y-auto">
          <pre className="text-xs text-gray-100 whitespace-pre-wrap">{kiroPrompt}</pre>
        </div>
        <p className="text-xs text-gray-400 mt-2">
          {t('autoseed.pasteHint')}
        </p>
      </div>
    </div>
  )
}
