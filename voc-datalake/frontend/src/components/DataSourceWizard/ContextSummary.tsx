/**
 * ContextSummary component - displays summary of selected context
 */
import { useTranslation } from 'react-i18next'
import type { ContextConfig } from './types'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

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
  const { t } = useTranslation('components')
  if (!config.useFeedback) return null
  return (
    <div className="space-y-1">
      <p><span className="text-gray-500">{t('dataSourceWizard.sources')}:</span> {formatConfigList(config.sources, 'All')}</p>
      <p><span className="text-gray-500">{t('dataSourceWizard.categories')}:</span> {formatConfigList(config.categories, 'All')}</p>
      <p><span className="text-gray-500">{t('dataSourceWizard.sentiments')}:</span> {formatConfigList(config.sentiments, 'All')}</p>
      <p><span className="text-gray-500">{t('dataSourceWizard.timeRange')}:</span> {t('dataSourceWizard.lastDays', { days: config.days })}</p>
    </div>
  )
}

export default function ContextSummary({
  config, personas, documents,
}: ContextSummaryProps) {
  const { t } = useTranslation('components')
  const selectedPersonas = personas.filter((p) => config.selectedPersonaIds.includes(p.persona_id))
  const researchDocs = documents.filter((d) => d.document_type === 'research')
  const otherDocs = documents.filter((d) => d.document_type !== 'research')
  const selectedDocs = otherDocs.filter((d) => config.selectedDocumentIds.includes(d.document_id))
  const selectedResearch = researchDocs.filter((d) => config.selectedResearchIds.includes(d.document_id))

  const hasNoSources = !config.useFeedback && !config.usePersonas && !config.useDocuments && !config.useResearch

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
      <h4 className="font-medium">{t('dataSourceWizard.contextSummary')}</h4>

      <FeedbackSection config={config} />

      {config.usePersonas ? <p><span className="text-gray-500">{t('dataSourceWizard.selectPersonas')}:</span> {
        formatListOrAll(selectedPersonas.map((p) => p.name), personas.length, 'personas')
      }</p> : null}

      {config.useDocuments ? <p><span className="text-gray-500">{t('dataSourceWizard.selectDocuments')}:</span> {
        formatListOrAll(selectedDocs.map((d) => d.title), otherDocs.length, 'documents')
      }</p> : null}

      {config.useResearch ? <p><span className="text-gray-500">{t('dataSourceWizard.selectResearchDocuments')}:</span> {
        formatListOrAll(selectedResearch.map((d) => d.title), researchDocs.length, 'research docs')
      }</p> : null}

      {hasNoSources ? <p className="text-gray-400 italic">{t('dataSourceWizard.noDataSourcesSelected')}</p> : null}
    </div>
  )
}
