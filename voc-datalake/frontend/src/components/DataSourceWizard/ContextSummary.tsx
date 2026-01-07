/**
 * ContextSummary component - displays summary of selected context
 */
import type { ProjectPersona, ProjectDocument } from '../../api/client'
import type { ContextConfig } from './types'

interface ContextSummaryProps {
  readonly config: ContextConfig
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
}

function formatListOrAll(items: string[], allCount: number, allLabel: string): string {
  return items.length > 0 ? items.join(', ') : `All ${allCount} ${allLabel}`
}

function formatConfigList(items: string[], fallback: string): string {
  return items.length > 0 ? items.join(', ') : fallback
}

// Feedback section component
function FeedbackSection({ config }: Readonly<{ config: ContextConfig }>) {
  if (!config.useFeedback) return null
  return (
    <div className="space-y-1">
      <p><span className="text-gray-500">Sources:</span> {formatConfigList(config.sources, 'All')}</p>
      <p><span className="text-gray-500">Categories:</span> {formatConfigList(config.categories, 'All')}</p>
      <p><span className="text-gray-500">Sentiments:</span> {formatConfigList(config.sentiments, 'All')}</p>
      <p><span className="text-gray-500">Time Range:</span> Last {config.days} days</p>
    </div>
  )
}

export default function ContextSummary({ config, personas, documents }: ContextSummaryProps) {
  const selectedPersonas = personas.filter(p => config.selectedPersonaIds.includes(p.persona_id))
  const researchDocs = documents.filter(d => d.document_type === 'research')
  const otherDocs = documents.filter(d => d.document_type !== 'research')
  const selectedDocs = otherDocs.filter(d => config.selectedDocumentIds.includes(d.document_id))
  const selectedResearch = researchDocs.filter(d => config.selectedResearchIds.includes(d.document_id))

  const hasNoSources = !config.useFeedback && !config.usePersonas && !config.useDocuments && !config.useResearch

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
      <h4 className="font-medium">Context Summary</h4>
      
      <FeedbackSection config={config} />
      
      {config.usePersonas && (
        <p><span className="text-gray-500">Personas:</span> {
          formatListOrAll(selectedPersonas.map(p => p.name), personas.length, 'personas')
        }</p>
      )}
      
      {config.useDocuments && (
        <p><span className="text-gray-500">Documents:</span> {
          formatListOrAll(selectedDocs.map(d => d.title), otherDocs.length, 'documents')
        }</p>
      )}
      
      {config.useResearch && (
        <p><span className="text-gray-500">Research:</span> {
          formatListOrAll(selectedResearch.map(d => d.title), researchDocs.length, 'research docs')
        }</p>
      )}
      
      {hasNoSources && (
        <p className="text-gray-400 italic">No data sources selected</p>
      )}
    </div>
  )
}
