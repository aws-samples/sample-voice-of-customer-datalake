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
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import { useConfigStore } from '../../store/configStore'
import { generateKiroPrompt } from './generateKiroPrompt'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

interface AutoseedContentProps {
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  /** Pre-built autoseed curl URL from the shared selection held in McpAccessTab. */
  readonly curlUrl: string
  /**
   * Whether the user has at least one persona or document selected.
   * Passed from McpAccessTab so this component doesn't have to infer it from
   * the URL string (which always contains at least the base path).
   */
  readonly hasSelection: boolean
}

export default function AutoseedContent({
  personas, documents, curlUrl, hasSelection,
}: AutoseedContentProps) {
  const { config } = useConfigStore()
  const { t } = useTranslation('projectDetail')
  // markCopied, not copy: handleCopy awaits its own writeText so a rejection can
  // be surfaced, and copy() would write a second time and swallow that failure.
  const { markCopied, copiedKey } = useCopyToClipboard()
  const [copyError, setCopyError] = useState<string | null>(null)

  const kiroPrompt = generateKiroPrompt(curlUrl)

  const handleCopy = useCallback(async () => {
    setCopyError(null)
    try {
      await navigator.clipboard.writeText(kiroPrompt)
      markCopied('kiro-autoseed')
    } catch (err) {
      console.error('[AutoseedContent] clipboard write failed:', err)
      setCopyError(t('autoseed.copyFailed'))
    }
  }, [kiroPrompt, markCopied, t])

  const isEmpty = personas.length === 0 && documents.length === 0

  if (isEmpty) {
    return (
      <p className="text-sm text-gray-400 text-center py-2">
        {t('autoseed.generateFirst')}
      </p>
    )
  }

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
            {copiedKey === 'kiro-autoseed' ? <Check size={16} /> : <Copy size={16} />}
            {copiedKey === 'kiro-autoseed' ? t('mcp.copied') : t('autoseed.copyKiroPrompt')}
          </button>
        </div>
        {copyError != null && (
          <p className="text-sm text-red-600 mb-2" role="alert">{copyError}</p>
        )}
        {/* The snippet is SUPPRESSED, not merely uncopyable-by-button, when a
            section is fully deselected: the curl it contains omits that section's
            filter, and the API reads an absent filter as "all". Rendering it while
            disabling the button would still let a user select the text by hand and
            seed everything they had just deselected. */}
        {hasSelection ? (
          <>
            <div className="bg-gray-900 rounded-lg p-4 max-h-48 overflow-y-auto">
              <pre className="text-xs text-gray-100 whitespace-pre-wrap">{kiroPrompt}</pre>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              {t('autoseed.pasteHint')}
            </p>
          </>
        ) : (
          <p className="text-sm text-gray-500">{t('export.selectAtLeastOne')}</p>
        )}
      </div>
    </div>
  )
}
