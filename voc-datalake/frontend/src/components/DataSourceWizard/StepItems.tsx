/**
 * @fileoverview Shared item components and helpers for DataSourceSteps.
 * @module components/DataSourceWizard/StepItems
 */

import clsx from 'clsx'
import { FileText } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ContextConfig } from './types'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

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

export function DataSourceCheckbox({
  checked, onChange, title, description,
}: DataSourceCheckboxProps) {
  return (
    <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-gray-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="w-4 h-4"
        aria-label={title}
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

function PersonaItem({
  persona, isSelected, onToggle,
}: PersonaItemProps) {
  return (
    <label className="flex items-center gap-2 sm:gap-3 p-2 rounded-lg border cursor-pointer hover:bg-gray-50 active:bg-gray-100">
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(e) => onToggle(e.target.checked)}
        className="w-4 h-4 flex-shrink-0"
        aria-label={persona.name}
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

function DocumentItem({
  document, isSelected, onToggle,
}: DocumentItemProps) {
  return (
    <label className="flex items-center gap-2 sm:gap-3 p-2 rounded-lg border cursor-pointer hover:bg-gray-50 active:bg-gray-100">
      <input
        type="checkbox"
        checked={isSelected}
        onChange={(e) => onToggle(e.target.checked)}
        className="w-4 h-4 flex-shrink-0"
        aria-label={document.title}
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

// Persona Selection Section
interface PersonaSelectionProps {
  readonly personas: ReadonlyArray<ProjectPersona>
  readonly selectedIds: string[]
  readonly onToggle: (personaId: string, checked: boolean) => void
}

export function PersonaSelection({
  personas, selectedIds, onToggle,
}: PersonaSelectionProps) {
  const { t } = useTranslation('components')
  return (
    <div>
      <h3 className="font-medium mb-2 sm:mb-3">{t('dataSourceWizard.selectPersonas')}</h3>
      <p className="text-sm text-gray-500 mb-2 sm:mb-3">{t('dataSourceWizard.leaveEmptyForAllPersonas')}</p>
      <div className="space-y-2 max-h-40 sm:max-h-48 overflow-y-auto">
        {personas.map((p) => (
          <PersonaItem
            key={p.persona_id}
            persona={p}
            isSelected={selectedIds.includes(p.persona_id)}
            onToggle={(checked) => onToggle(p.persona_id, checked)}
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

export function DocumentSelection({
  title,
  description,
  documents,
  selectedDocIds,
  selectedResearchIds,
  onToggle,
  maxHeight = 'max-h-40 sm:max-h-48',
}: DocumentSelectionProps) {
  return (
    <div>
      <h3 className="font-medium mb-2 sm:mb-3">{title}</h3>
      <p className="text-sm text-gray-500 mb-2 sm:mb-3">{description}</p>
      <div className={clsx('space-y-2 overflow-y-auto', maxHeight)}>
        {documents.map((d) => {
          const isResearch = d.document_type === 'research'
          const isSelected = isResearch
            ? selectedResearchIds.includes(d.document_id)
            : selectedDocIds.includes(d.document_id)
          return (
            <DocumentItem
              key={d.document_id}
              document={d}
              isSelected={isSelected}
              onToggle={(checked) => onToggle(d, checked)}
            />
          )
        })}
      </div>
    </div>
  )
}

// Item Selection Documents Section
interface ItemSelectionDocumentsProps {
  readonly contextConfig: ContextConfig
  readonly documents: ReadonlyArray<ProjectDocument>
  readonly otherDocs: ReadonlyArray<ProjectDocument>
  readonly researchDocs: ReadonlyArray<ProjectDocument>
  readonly combineDocuments: boolean
  readonly onToggle: (doc: ProjectDocument, checked: boolean) => void
}

function CombinedDocsSection({
  contextConfig, documents, combineDocuments, onToggle,
}: {
  readonly contextConfig: ContextConfig
  readonly documents: ReadonlyArray<ProjectDocument>
  readonly combineDocuments: boolean
  readonly onToggle: (doc: ProjectDocument, checked: boolean) => void
}) {
  const { t } = useTranslation('components')
  const shouldShow = combineDocuments
    && (contextConfig.useDocuments || contextConfig.useResearch)
    && documents.length > 0
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

export function ItemSelectionDocuments({
  contextConfig,
  documents,
  otherDocs,
  researchDocs,
  combineDocuments,
  onToggle,
}: ItemSelectionDocumentsProps) {
  const { t } = useTranslation('components')
  const showOtherDocs = !combineDocuments && contextConfig.useDocuments && otherDocs.length > 0
  const showResearchDocs = !combineDocuments && contextConfig.useResearch && researchDocs.length > 0

  return (
    <>
      <CombinedDocsSection
        contextConfig={contextConfig}
        documents={documents}
        combineDocuments={combineDocuments}
        onToggle={onToggle}
      />
      {showOtherDocs ? (
        <DocumentSelection
          title={t('dataSourceWizard.selectDocuments')}
          description={t('dataSourceWizard.leaveEmptyForAllDocuments')}
          documents={otherDocs}
          selectedDocIds={contextConfig.selectedDocumentIds}
          selectedResearchIds={contextConfig.selectedResearchIds}
          onToggle={onToggle}
        />
      ) : null}
      {showResearchDocs ? (
        <DocumentSelection
          title={t('dataSourceWizard.selectResearchDocuments')}
          description={t('dataSourceWizard.leaveEmptyForAllResearch')}
          documents={researchDocs}
          selectedDocIds={contextConfig.selectedDocumentIds}
          selectedResearchIds={contextConfig.selectedResearchIds}
          onToggle={onToggle}
        />
      ) : null}
    </>
  )
}
