/**
 * @fileoverview Step components for the DataSourceWizard.
 * @module components/DataSourceWizard/DataSourceSteps
 */

import { Loader2, FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectPersona, ProjectDocument } from '../../api/client'
import { SENTIMENTS } from '../../constants/filters'
import clsx from 'clsx'
import type { ContextConfig } from './types'

type ColorConfig = {
  bg: string
  bgLight: string
  border: string
  text: string
  hover: string
}

// Helper functions
function getSentimentClass(sentiment: string, isSelected: boolean, colors: ColorConfig): string {
  if (!isSelected) return 'bg-white border-gray-200'
  if (sentiment === 'positive') return 'bg-green-100 border-green-300 text-green-700'
  if (sentiment === 'negative') return 'bg-red-100 border-red-300 text-red-700'
  return `${colors.bgLight} ${colors.border} ${colors.text}`
}

function formatSourceName(source: string): string {
  return source.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

function toggleArrayItem(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item]
}

function getDocBgClass(type: string): string {
  if (type === 'prd') return 'bg-blue-100'
  if (type === 'prfaq') return 'bg-green-100'
  if (type === 'research') return 'bg-amber-100'
  return 'bg-purple-100'
}

function getDocTextClass(type: string): string {
  if (type === 'prd') return 'text-blue-600'
  if (type === 'prfaq') return 'text-green-600'
  if (type === 'research') return 'text-amber-600'
  return 'text-purple-600'
}

// Data Source Checkbox Component
interface DataSourceCheckboxProps {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly title: string
  readonly description: string
}

function DataSourceCheckbox({ checked, onChange, title, description }: DataSourceCheckboxProps) {
  return (
    <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="w-4 h-4"
      />
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-sm text-gray-500">{description}</div>
      </div>
    </label>
  )
}

// Persona Selection Item Component
interface PersonaItemProps {
  readonly persona: ProjectPersona
  readonly isSelected: boolean
  readonly onToggle: (checked: boolean) => void
}

function PersonaItem({ persona, isSelected, onToggle }: PersonaItemProps) {
  return (
    <label className="flex items-center gap-2 sm:gap-3 p-2 rounded-lg border cursor-pointer hover:bg-gray-50 active:bg-gray-100">
      <input
        type="checkbox"
        checked={isSelected}
        onChange={e => onToggle(e.target.checked)}
        className="w-4 h-4 flex-shrink-0"
      />
      <div className="w-7 h-7 sm:w-8 sm:h-8 bg-gradient-to-br from-purple-500 to-pink-500 rounded-full flex items-center justify-center text-white font-bold text-xs sm:text-sm flex-shrink-0">
        {persona.name.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{persona.name}</div>
        <div className="text-xs text-gray-500 truncate">{persona.tagline}</div>
      </div>
    </label>
  )
}

// Document Selection Item Component
interface DocumentItemProps {
  readonly document: ProjectDocument
  readonly isSelected: boolean
  readonly onToggle: (checked: boolean) => void
}

function DocumentItem({ document, isSelected, onToggle }: DocumentItemProps) {
  return (
    <label className="flex items-center gap-2 sm:gap-3 p-2 rounded-lg border cursor-pointer hover:bg-gray-50 active:bg-gray-100">
      <input
        type="checkbox"
        checked={isSelected}
        onChange={e => onToggle(e.target.checked)}
        className="w-4 h-4 flex-shrink-0"
      />
      <div className={clsx('w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center flex-shrink-0', getDocBgClass(document.document_type))}>
        <FileText size={14} className={getDocTextClass(document.document_type)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{document.title}</div>
        <div className="text-xs text-gray-500">{document.document_type.toUpperCase()}</div>
      </div>
    </label>
  )
}

// Data Sources Step Component
interface DataSourcesStepProps {
  readonly contextConfig: ContextConfig
  readonly onContextChange: (config: ContextConfig) => void
  readonly showFeedback: boolean
  readonly showPersonas: boolean
  readonly showDocuments: boolean
  readonly showResearch: boolean
  readonly combineDocuments: boolean
  readonly personasCount: number
  readonly documentsCount: number
  readonly otherDocsCount: number
  readonly researchDocsCount: number
}

export function DataSourcesStep({
  contextConfig,
  onContextChange,
  showFeedback,
  showPersonas,
  showDocuments,
  showResearch,
  combineDocuments,
  personasCount,
  documentsCount,
  otherDocsCount,
  researchDocsCount,
}: DataSourcesStepProps) {
  const { t } = useTranslation('components')
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('dataSourceWizard.dataSources')}</h3>
        <p className="text-sm text-gray-500 mb-3 sm:mb-4">{t('dataSourceWizard.dataSourcesDescription')}</p>
        <div className="space-y-2">
          {showFeedback && (
            <DataSourceCheckbox
              checked={contextConfig.useFeedback}
              onChange={checked => onContextChange({ ...contextConfig, useFeedback: checked })}
              title={t('dataSourceWizard.customerFeedback')}
              description={t('dataSourceWizard.customerFeedbackDescription')}
            />
          )}
          
          {showPersonas && (
            <DataSourceCheckbox
              checked={contextConfig.usePersonas}
              onChange={checked => onContextChange({ 
                ...contextConfig, 
                usePersonas: checked, 
                selectedPersonaIds: checked ? contextConfig.selectedPersonaIds : [] 
              })}
              title={t('dataSourceWizard.personasCount', { count: personasCount })}
              description={t('dataSourceWizard.personasDescription')}
            />
          )}
          
          {combineDocuments && documentsCount > 0 && (
            <DataSourceCheckbox
              checked={contextConfig.useDocuments || contextConfig.useResearch}
              onChange={checked => onContextChange({ 
                ...contextConfig, 
                useDocuments: checked, 
                useResearch: checked,
                selectedDocumentIds: checked ? contextConfig.selectedDocumentIds : [],
                selectedResearchIds: checked ? contextConfig.selectedResearchIds : []
              })}
              title={t('dataSourceWizard.documentsCount', { count: documentsCount })}
              description={t('dataSourceWizard.selectDocumentsToMerge')}
            />
          )}

          {!combineDocuments && showDocuments && (
            <DataSourceCheckbox
              checked={contextConfig.useDocuments}
              onChange={checked => onContextChange({ 
                ...contextConfig, 
                useDocuments: checked, 
                selectedDocumentIds: checked ? contextConfig.selectedDocumentIds : [] 
              })}
              title={t('dataSourceWizard.existingDocumentsCount', { count: otherDocsCount })}
              description={t('dataSourceWizard.existingDocumentsDescription')}
            />
          )}
          
          {!combineDocuments && showResearch && (
            <DataSourceCheckbox
              checked={contextConfig.useResearch}
              onChange={checked => onContextChange({ 
                ...contextConfig, 
                useResearch: checked, 
                selectedResearchIds: checked ? contextConfig.selectedResearchIds : [] 
              })}
              title={t('dataSourceWizard.researchDocumentsCount', { count: researchDocsCount })}
              description={t('dataSourceWizard.researchDescription')}
            />
          )}
        </div>
      </div>
    </div>
  )
}

// Feedback Filters Step Component
interface FeedbackFiltersStepProps {
  readonly contextConfig: ContextConfig
  readonly onContextChange: (config: ContextConfig) => void
  readonly sources: string[]
  readonly categories: ReadonlyArray<{ id: string; name: string }>
  readonly loadingCategories: boolean
  readonly colors: ColorConfig
}

export function FeedbackFiltersStep({
  contextConfig,
  onContextChange,
  sources,
  categories,
  loadingCategories,
  colors,
}: FeedbackFiltersStepProps) {
  const { t } = useTranslation('components')
  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('dataSourceWizard.sources')}</h3>
        <p className="text-sm text-gray-500 mb-2">{t('dataSourceWizard.leaveEmptyForAllSources')}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {sources.map(s => (
            <button
              key={s}
              onClick={() => onContextChange({ ...contextConfig, sources: toggleArrayItem(contextConfig.sources, s) })}
              className={clsx(
                'px-2 sm:px-3 py-2 rounded-lg border text-xs sm:text-sm truncate',
                contextConfig.sources.includes(s) ? `${colors.bgLight} ${colors.border} ${colors.text}` : 'bg-white border-gray-200'
              )}
            >
              {formatSourceName(s)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('dataSourceWizard.categories')}</h3>
        {loadingCategories ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 size={20} className="animate-spin text-gray-400" />
            <span className="ml-2 text-sm text-gray-500">{t('dataSourceWizard.loadingCategories')}</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {categories.map(c => (
              <button
                key={c.id}
                onClick={() => onContextChange({ ...contextConfig, categories: toggleArrayItem(contextConfig.categories, c.id) })}
                className={clsx(
                  'px-2 sm:px-3 py-2 rounded-lg border text-xs sm:text-sm truncate',
                  contextConfig.categories.includes(c.id) ? `${colors.bgLight} ${colors.border} ${colors.text}` : 'bg-white border-gray-200'
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('dataSourceWizard.sentiments')}</h3>
        <div className="flex flex-col sm:flex-row gap-2">
          {SENTIMENTS.map(s => (
            <button
              key={s}
              onClick={() => onContextChange({ ...contextConfig, sentiments: toggleArrayItem(contextConfig.sentiments, s) })}
              className={clsx(
                'px-3 sm:px-4 py-2 rounded-lg border text-sm flex-1 capitalize',
                getSentimentClass(s, contextConfig.sentiments.includes(s), colors)
              )}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('dataSourceWizard.timeRange')}</h3>
        <select
          value={contextConfig.days}
          onChange={e => onContextChange({ ...contextConfig, days: +e.target.value })}
          className="w-full px-3 py-2.5 sm:py-2 border rounded-lg text-sm sm:text-base"
        >
          <option value={7}>{t('dataSourceWizard.lastDays', { days: 7 })}</option>
          <option value={14}>{t('dataSourceWizard.lastDays', { days: 14 })}</option>
          <option value={30}>{t('dataSourceWizard.lastDays', { days: 30 })}</option>
          <option value={60}>{t('dataSourceWizard.lastDays', { days: 60 })}</option>
          <option value={90}>{t('dataSourceWizard.lastDays', { days: 90 })}</option>
          <option value={365}>{t('dataSourceWizard.lastYear')}</option>
          <option value={3650}>{t('dataSourceWizard.allTime')}</option>
        </select>
      </div>
    </div>
  )
}

// Persona Selection Section
interface PersonaSelectionProps {
  readonly personas: ReadonlyArray<ProjectPersona>
  readonly selectedIds: string[]
  readonly onToggle: (personaId: string, checked: boolean) => void
}

function PersonaSelection({ personas, selectedIds, onToggle }: PersonaSelectionProps) {
  const { t } = useTranslation('components')
  return (
    <div>
      <h3 className="font-medium mb-2 sm:mb-3">{t('dataSourceWizard.selectPersonas')}</h3>
      <p className="text-sm text-gray-500 mb-2 sm:mb-3">{t('dataSourceWizard.leaveEmptyForAllPersonas')}</p>
      <div className="space-y-2 max-h-40 sm:max-h-48 overflow-y-auto">
        {personas.map(p => (
          <PersonaItem
            key={p.persona_id}
            persona={p}
            isSelected={selectedIds.includes(p.persona_id)}
            onToggle={checked => onToggle(p.persona_id, checked)}
          />
        ))}
      </div>
    </div>
  )
}

// Document Selection Section
interface DocumentSelectionProps {
  readonly title: string
  readonly description: string
  readonly documents: ReadonlyArray<ProjectDocument>
  readonly selectedDocIds: string[]
  readonly selectedResearchIds: string[]
  readonly onToggle: (doc: ProjectDocument, checked: boolean) => void
  readonly maxHeight?: string
}

function DocumentSelection({ 
  title, 
  description, 
  documents, 
  selectedDocIds, 
  selectedResearchIds, 
  onToggle,
  maxHeight = 'max-h-40 sm:max-h-48'
}: DocumentSelectionProps) {
  return (
    <div>
      <h3 className="font-medium mb-2 sm:mb-3">{title}</h3>
      <p className="text-sm text-gray-500 mb-2 sm:mb-3">{description}</p>
      <div className={clsx('space-y-2 overflow-y-auto', maxHeight)}>
        {documents.map(d => {
          const isResearch = d.document_type === 'research'
          const isSelected = isResearch 
            ? selectedResearchIds.includes(d.document_id)
            : selectedDocIds.includes(d.document_id)
          return (
            <DocumentItem
              key={d.document_id}
              document={d}
              isSelected={isSelected}
              onToggle={checked => onToggle(d, checked)}
            />
          )
        })}
      </div>
    </div>
  )
}

// Item Selection Step Component
interface ItemSelectionStepProps {
  readonly contextConfig: ContextConfig
  readonly onContextChange: (config: ContextConfig) => void
  readonly personas: ReadonlyArray<ProjectPersona>
  readonly documents: ReadonlyArray<ProjectDocument>
  readonly otherDocs: ReadonlyArray<ProjectDocument>
  readonly researchDocs: ReadonlyArray<ProjectDocument>
  readonly combineDocuments: boolean
}

export function ItemSelectionStep({
  contextConfig,
  onContextChange,
  personas,
  documents,
  otherDocs,
  researchDocs,
  combineDocuments,
}: ItemSelectionStepProps) {
  const handlePersonaToggle = (personaId: string, checked: boolean) => {
    onContextChange({
      ...contextConfig,
      selectedPersonaIds: checked
        ? [...contextConfig.selectedPersonaIds, personaId]
        : contextConfig.selectedPersonaIds.filter(id => id !== personaId)
    })
  }

  const handleDocumentToggle = (doc: ProjectDocument, checked: boolean) => {
    const isResearch = doc.document_type === 'research'
    if (isResearch) {
      onContextChange({
        ...contextConfig,
        selectedResearchIds: checked
          ? [...contextConfig.selectedResearchIds, doc.document_id]
          : contextConfig.selectedResearchIds.filter(id => id !== doc.document_id)
      })
    } else {
      onContextChange({
        ...contextConfig,
        selectedDocumentIds: checked
          ? [...contextConfig.selectedDocumentIds, doc.document_id]
          : contextConfig.selectedDocumentIds.filter(id => id !== doc.document_id)
      })
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <PersonaSelectionSection
        contextConfig={contextConfig}
        personas={personas}
        onToggle={handlePersonaToggle}
      />
      <CombinedDocumentsSection
        contextConfig={contextConfig}
        documents={documents}
        combineDocuments={combineDocuments}
        onToggle={handleDocumentToggle}
      />
      <OtherDocumentsSection
        contextConfig={contextConfig}
        otherDocs={otherDocs}
        combineDocuments={combineDocuments}
        onToggle={handleDocumentToggle}
      />
      <ResearchDocumentsSection
        contextConfig={contextConfig}
        researchDocs={researchDocs}
        combineDocuments={combineDocuments}
        onToggle={handleDocumentToggle}
      />
    </div>
  )
}

// Helper section components
interface PersonaSelectionSectionProps {
  readonly contextConfig: ContextConfig
  readonly personas: ReadonlyArray<ProjectPersona>
  readonly onToggle: (personaId: string, checked: boolean) => void
}

function PersonaSelectionSection({ contextConfig, personas, onToggle }: PersonaSelectionSectionProps) {
  if (!contextConfig.usePersonas || personas.length === 0) return null
  return (
    <PersonaSelection
      personas={personas}
      selectedIds={contextConfig.selectedPersonaIds}
      onToggle={onToggle}
    />
  )
}

interface CombinedDocumentsSectionProps {
  readonly contextConfig: ContextConfig
  readonly documents: ReadonlyArray<ProjectDocument>
  readonly combineDocuments: boolean
  readonly onToggle: (doc: ProjectDocument, checked: boolean) => void
}

function CombinedDocumentsSection({ contextConfig, documents, combineDocuments, onToggle }: CombinedDocumentsSectionProps) {
  const { t } = useTranslation('components')
  const shouldShow = combineDocuments && (contextConfig.useDocuments || contextConfig.useResearch) && documents.length > 0
  if (!shouldShow) return null
  return (
    <DocumentSelection
      title={t('dataSourceWizard.selectDocuments')}
      description={t('dataSourceWizard.selectDocumentsToMerge')}
      documents={documents}
      selectedDocIds={contextConfig.selectedDocumentIds}
      selectedResearchIds={contextConfig.selectedResearchIds}
      onToggle={onToggle}
      maxHeight="max-h-56 sm:max-h-64"
    />
  )
}

interface OtherDocumentsSectionProps {
  readonly contextConfig: ContextConfig
  readonly otherDocs: ReadonlyArray<ProjectDocument>
  readonly combineDocuments: boolean
  readonly onToggle: (doc: ProjectDocument, checked: boolean) => void
}

function OtherDocumentsSection({ contextConfig, otherDocs, combineDocuments, onToggle }: OtherDocumentsSectionProps) {
  const { t } = useTranslation('components')
  const shouldShow = !combineDocuments && contextConfig.useDocuments && otherDocs.length > 0
  if (!shouldShow) return null
  return (
    <DocumentSelection
      title={t('dataSourceWizard.selectDocuments')}
      description={t('dataSourceWizard.leaveEmptyForAllDocuments')}
      documents={otherDocs}
      selectedDocIds={contextConfig.selectedDocumentIds}
      selectedResearchIds={contextConfig.selectedResearchIds}
      onToggle={onToggle}
    />
  )
}

interface ResearchDocumentsSectionProps {
  readonly contextConfig: ContextConfig
  readonly researchDocs: ReadonlyArray<ProjectDocument>
  readonly combineDocuments: boolean
  readonly onToggle: (doc: ProjectDocument, checked: boolean) => void
}

function ResearchDocumentsSection({ contextConfig, researchDocs, combineDocuments, onToggle }: ResearchDocumentsSectionProps) {
  const { t } = useTranslation('components')
  const shouldShow = !combineDocuments && contextConfig.useResearch && researchDocs.length > 0
  if (!shouldShow) return null
  return (
    <DocumentSelection
      title={t('dataSourceWizard.selectResearchDocuments')}
      description={t('dataSourceWizard.leaveEmptyForAllResearch')}
      documents={researchDocs}
      selectedDocIds={contextConfig.selectedDocumentIds}
      selectedResearchIds={contextConfig.selectedResearchIds}
      onToggle={onToggle}
    />
  )
}
