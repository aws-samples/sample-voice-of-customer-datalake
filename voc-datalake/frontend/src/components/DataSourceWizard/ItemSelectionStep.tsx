/**
 * @fileoverview The persona and document selection step of the DataSourceWizard.
 * @module components/DataSourceWizard/ItemSelectionStep
 */

import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ContextConfig } from './types'

function getDocBgClass(type: string): string {
  if (type === 'prd') return 'bg-info-subtle'
  if (type === 'prfaq') return 'bg-ok-subtle'
  if (type === 'research') return 'bg-warn-subtle'
  return 'bg-aim-subtle'
}

function getDocTextClass(type: string): string {
  if (type === 'prd') return 'text-info'
  if (type === 'prfaq') return 'text-ok'
  if (type === 'research') return 'text-warn'
  return 'text-aim'
}

// Selectable row shared by the persona and document pickers: a bordered label
// whose leading checkbox toggles the item, followed by the row's own content.
interface SelectableRowProps {
  readonly isSelected: boolean
  readonly onToggle: (checked: boolean) => void
  readonly children: React.ReactNode
}

function SelectableRow({ isSelected, onToggle, children }: SelectableRowProps) {
  return (
    <label className="flex items-center gap-2 sm:gap-3 p-2 rounded-lg border cursor-pointer hover:bg-bg-hover active:bg-bg-hover">
      <input
        type="checkbox"
        checked={isSelected}
        onChange={e => onToggle(e.target.checked)}
        className="w-4 h-4 flex-shrink-0 accent-accent"
      />
      {children}
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
    <SelectableRow isSelected={isSelected} onToggle={onToggle}>
      <div className="w-7 h-7 sm:w-8 sm:h-8 bg-accent rounded-full flex items-center justify-center text-accent-fg font-bold text-xs sm:text-sm flex-shrink-0">
        {persona.name.charAt(0)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{persona.name}</div>
        <div className="text-xs text-muted truncate">{persona.tagline}</div>
      </div>
    </SelectableRow>
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
    <SelectableRow isSelected={isSelected} onToggle={onToggle}>
      <div className={clsx('w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center flex-shrink-0', getDocBgClass(document.document_type))}>
        <FileText size={14} className={getDocTextClass(document.document_type)} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm truncate">{document.title}</div>
        <div className="text-xs text-muted">{document.document_type.toUpperCase()}</div>
      </div>
    </SelectableRow>
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
      <h3 className="font-medium mb-2 sm:mb-3">{t('components:dataSourceWizard.selectPersonas')}</h3>
      <p className="text-sm text-muted mb-2 sm:mb-3">{t('components:dataSourceWizard.leaveEmptyForAllPersonas')}</p>
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
      <p className="text-sm text-muted mb-2 sm:mb-3">{description}</p>
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
      title={t('components:dataSourceWizard.selectDocuments')}
      description={t('components:dataSourceWizard.selectDocumentsToMerge')}
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
      title={t('components:dataSourceWizard.selectDocuments')}
      description={t('components:dataSourceWizard.leaveEmptyForAllDocuments')}
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
      title={t('components:dataSourceWizard.selectResearchDocuments')}
      description={t('components:dataSourceWizard.leaveEmptyForAllResearch')}
      documents={researchDocs}
      selectedDocIds={contextConfig.selectedDocumentIds}
      selectedResearchIds={contextConfig.selectedResearchIds}
      onToggle={onToggle}
    />
  )
}
