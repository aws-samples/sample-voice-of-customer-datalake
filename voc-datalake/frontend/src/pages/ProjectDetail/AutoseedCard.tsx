/**
 * AutoseedCard - Picker UI for selecting personas and documents to autoseed into a Kiro workspace.
 * Generates a Kiro prompt with curl command that includes selected IDs as query params.
 */
import {
  Link, Copy, Check,
} from 'lucide-react'
import {
  useState, useCallback, useMemo,
} from 'react'
import { useTranslation } from 'react-i18next'
import { stripTrailingSlashes } from '../../api/baseUrl'
import { PickerSection, CheckboxItem } from './PickerComponents'
import { useConfigStore } from '../../store/configStore'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

interface AutoseedCardProps {
  readonly projectId: string
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
}

type DocType = 'prd' | 'prfaq' | 'research' | 'custom'

const DOC_TYPE_LABELS: Record<DocType, string> = {
  prd: 'PRDs',
  prfaq: 'PR/FAQs',
  research: 'Research',
  custom: 'Custom',
}

function groupDocumentsByType(documents: ProjectDocument[]): Record<DocType, ProjectDocument[]> {
  const groups: Record<DocType, ProjectDocument[]> = {
    prd: [],
    prfaq: [],
    research: [],
    custom: [],
  }
  for (const doc of documents) {
    const docType = isValidDocType(doc.document_type) ? doc.document_type : 'custom'
    groups[docType].push(doc)
  }
  return groups
}

function isValidDocType(value: string): value is DocType {
  return value === 'prd' || value === 'prfaq' || value === 'research' || value === 'custom'
}

export default function AutoseedCard({
  projectId, personas, documents,
}: AutoseedCardProps) {
  const { config } = useConfigStore()
  const { t } = useTranslation('projectDetail')
  const [selectedPersonaIds, setSelectedPersonaIds] = useState<Set<string>>(() => new Set(personas.map((p) => p.persona_id)))
  const [selectedDocumentIds, setSelectedDocumentIds] = useState<Set<string>>(() => new Set(documents.map((d) => d.document_id)))
  const [copied, setCopied] = useState(false)
  const [expandedSections, setExpandedSections] = useState<Set<string>>(() => new Set(['personas', 'documents']))

  const docGroups = useMemo(() => groupDocumentsByType(documents), [documents])

  const togglePersona = useCallback((id: string) => {
    setSelectedPersonaIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleDocument = useCallback((id: string) => {
    setSelectedDocumentIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const toggleAllPersonas = useCallback((select: boolean) => {
    setSelectedPersonaIds(select ? new Set(personas.map((p) => p.persona_id)) : new Set())
  }, [personas])

  const toggleAllDocuments = useCallback((select: boolean) => {
    setSelectedDocumentIds(select ? new Set(documents.map((d) => d.document_id)) : new Set())
  }, [documents])

  const toggleSection = useCallback((section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev)
      if (next.has(section)) next.delete(section)
      else next.add(section)
      return next
    })
  }, [])

  const apiBase = stripTrailingSlashes(config.apiEndpoint === '' ? '' : config.apiEndpoint)
  const hasSelection = selectedPersonaIds.size > 0 || selectedDocumentIds.size > 0

  const curlUrl = useMemo(() => {
    const params = new URLSearchParams()
    if (selectedPersonaIds.size > 0 && selectedPersonaIds.size < personas.length) {
      params.set('persona_ids', [...selectedPersonaIds].join(','))
    }
    if (selectedDocumentIds.size > 0 && selectedDocumentIds.size < documents.length) {
      params.set('document_ids', [...selectedDocumentIds].join(','))
    }
    const qs = params.toString()
    const base = `${apiBase}/projects/${projectId}/autoseed`
    return qs === '' ? base : `${base}?${qs}`
  }, [apiBase, projectId, selectedPersonaIds, selectedDocumentIds, personas.length, documents.length])

  const kiroPrompt = useMemo(() => `Seed my workspace with project context from VoC Data Lake.

Fetch the project data by running this curl command:

\`\`\`bash
curl -s "${curlUrl}" -H "Authorization: Bearer <YOUR_API_TOKEN>" -o /tmp/voc-autoseed.json
\`\`\`

Then read the JSON response. It contains a \`files\` array where each entry has a \`path\` and \`content\`. Write each file to my workspace at the specified path.

The files include:
- \`.kiro/steering/project-*.md\` — A steering file with project context, persona references, and implementation guidance
- \`.kiro/personas/*.md\` — One markdown file per user persona
- \`.kiro/docs/*.md\` — PRDs, PR/FAQs, and research documents

The steering file already contains \`#[[file:...]]\` references to the persona and document files, so Kiro will automatically include them as context.

Replace \`<YOUR_API_TOKEN>\` with your API token from the MCP Access tab.`, [curlUrl])

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(kiroPrompt)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }, [kiroPrompt])

  const isEmpty = personas.length === 0 && documents.length === 0

  return (
    <div className="bg-white rounded-xl p-6 border">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-100 rounded-lg flex items-center justify-center">
            <Link size={20} className="text-indigo-600" />
          </div>
          <div>
            <h3 className="font-semibold">{t('autoseed.title')}</h3>
            <p className="text-sm text-gray-500">{t('autoseed.description')}</p>
          </div>
        </div>
      </div>

      {isEmpty ? (
        <p className="text-sm text-gray-400 text-center py-4">
          {t('autoseed.generateFirst')}
        </p>
      ) : (
        <>
          {/* Persona picker */}
          {personas.length > 0 && (
            <PickerSection
              title={t('autoseed.personas', {
                selected: selectedPersonaIds.size,
                total: personas.length,
              })}
              expanded={expandedSections.has('personas')}
              onToggle={() => toggleSection('personas')}
              allSelected={selectedPersonaIds.size === personas.length}
              onToggleAll={(sel) => toggleAllPersonas(sel)}
            >
              {personas.map((p) => (
                <CheckboxItem
                  key={p.persona_id}
                  id={p.persona_id}
                  label={p.name}
                  sublabel={p.tagline}
                  checked={selectedPersonaIds.has(p.persona_id)}
                  onChange={() => togglePersona(p.persona_id)}
                />
              ))}
            </PickerSection>
          )}

          {/* Document picker grouped by type */}
          {documents.length > 0 && (
            <PickerSection
              title={t('autoseed.documents', {
                selected: selectedDocumentIds.size,
                total: documents.length,
              })}
              expanded={expandedSections.has('documents')}
              onToggle={() => toggleSection('documents')}
              allSelected={selectedDocumentIds.size === documents.length}
              onToggleAll={(sel) => toggleAllDocuments(sel)}
            >
              {Object.keys(docGroups)
                .filter(isValidDocType)
                .filter((type) => docGroups[type].length > 0)
                .map((type) => {
                  const docs = docGroups[type]
                  return (
                    <div key={type} className="mb-2">
                      <p className="text-xs font-medium text-gray-500 uppercase tracking-wide mb-1">{DOC_TYPE_LABELS[type]}</p>
                      {docs.map((d) => (
                        <CheckboxItem
                          key={d.document_id}
                          id={d.document_id}
                          label={d.title}
                          sublabel={d.document_type}
                          checked={selectedDocumentIds.has(d.document_id)}
                          onChange={() => toggleDocument(d.document_id)}
                        />
                      ))}
                    </div>
                  )
                })}
            </PickerSection>
          )}

          {/* Generated prompt */}
          <div className="mt-4">
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
        </>
      )}
    </div>
  )
}

// --- Sub-components ---

