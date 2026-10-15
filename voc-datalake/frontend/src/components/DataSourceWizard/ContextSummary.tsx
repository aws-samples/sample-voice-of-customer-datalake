/**
 * ContextSummary component - displays summary of selected context
 */
import { useTranslation } from 'react-i18next'
import type { ProjectPersona, ProjectDocument } from '../../api/client'
import type { ContextConfig } from './types'
import { useSentimentLabels, toSentimentLabels } from './sentimentLabels'

interface ContextSummaryProps {
  readonly config: ContextConfig
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
}

/**
 * Selected item names, or the caller's already-translated fallback when nothing
 * is selected. The fallback is resolved by the caller rather than assembled here
 * so a count and its noun stay inside one translatable string — "All 3 personas"
 * cannot be built from "All" + n + "personas" in every language.
 */
function formatListOrFallback(items: string[], fallback: string): string {
  return items.length > 0 ? items.join(', ') : fallback
}

/**
 * Field label plus its separator. Takes the RESOLVED label rather than a key so
 * every `t()` call stays a literal the i18n gate can see — `label(key)` would
 * hide them all behind a dynamic argument.
 */
function withSeparator(label: string, separator: string): string {
  return `${label}${separator}`
}

// Feedback section component
function FeedbackSection({ config }: Readonly<{ config: ContextConfig }>) {
  const { t } = useTranslation('components')
  const sentimentLabels = useSentimentLabels()
  if (!config.useFeedback) return null
  const all = t('components:dataSourceWizard.all')
  const sep = t('components:dataSourceWizard.labelSeparator')
  return (
    <div className="space-y-1">
      <p><span className="text-gray-500">{withSeparator(t('components:dataSourceWizard.sources'), sep)}</span> {formatListOrFallback(config.sources, all)}</p>
      <p><span className="text-gray-500">{withSeparator(t('components:dataSourceWizard.categories'), sep)}</span> {formatListOrFallback(config.categories, all)}</p>
      <p><span className="text-gray-500">{withSeparator(t('components:dataSourceWizard.sentiments'), sep)}</span> {
        formatListOrFallback(toSentimentLabels(config.sentiments, sentimentLabels), all)
      }</p>
      <p><span className="text-gray-500">{withSeparator(t('components:dataSourceWizard.timeRange'), sep)}</span> {t('components:dataSourceWizard.lastDays', { days: config.days })}</p>
    </div>
  )
}

export default function ContextSummary({ config, personas, documents }: ContextSummaryProps) {
  const { t } = useTranslation('components')
  const sep = t('components:dataSourceWizard.labelSeparator')
  const selectedPersonas = personas.filter(p => config.selectedPersonaIds.includes(p.persona_id))
  const researchDocs = documents.filter(d => d.document_type === 'research')
  const otherDocs = documents.filter(d => d.document_type !== 'research')
  const selectedDocs = otherDocs.filter(d => config.selectedDocumentIds.includes(d.document_id))
  const selectedResearch = researchDocs.filter(d => config.selectedResearchIds.includes(d.document_id))

  const hasNoSources = !config.useFeedback && !config.usePersonas && !config.useDocuments && !config.useResearch

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-2 text-sm">
      <h4 className="font-medium">{t('components:dataSourceWizard.contextSummary')}</h4>
      
      <FeedbackSection config={config} />
      
      {config.usePersonas && (
        <p><span className="text-gray-500">{withSeparator(t('components:dataSourceWizard.personas'), sep)}</span> {
          formatListOrFallback(
            selectedPersonas.map(p => p.name),
            t('components:dataSourceWizard.allPersonas', { count: personas.length }),
          )
        }</p>
      )}
      
      {config.useDocuments && (
        <p><span className="text-gray-500">{withSeparator(t('components:dataSourceWizard.documents'), sep)}</span> {
          formatListOrFallback(
            selectedDocs.map(d => d.title),
            t('components:dataSourceWizard.allDocuments', { count: otherDocs.length }),
          )
        }</p>
      )}
      
      {config.useResearch && (
        <p><span className="text-gray-500">{withSeparator(t('components:dataSourceWizard.research'), sep)}</span> {
          formatListOrFallback(
            selectedResearch.map(d => d.title),
            t('components:dataSourceWizard.allResearch', { count: researchDocs.length }),
          )
        }</p>
      )}
      
      {hasNoSources && (
        <p className="text-gray-400 italic">{t('components:dataSourceWizard.noDataSourcesSelected')}</p>
      )}
    </div>
  )
}
