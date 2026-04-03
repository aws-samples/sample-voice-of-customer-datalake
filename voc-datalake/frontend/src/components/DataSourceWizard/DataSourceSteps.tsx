/**
 * @fileoverview Step components for the DataSourceWizard.
 * @module components/DataSourceWizard/DataSourceSteps
 */

import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SENTIMENTS } from '../../constants/filters'
import { formatSourceName } from '../../lib/sourceFormat'
import {
  DataSourceCheckbox, PersonaSelection, ItemSelectionDocuments,
} from './StepItems'
import {
  getSentimentClass, toggleArrayItem,
  buildPersonaToggleConfig, buildDocToggleConfig,
} from './stepItemUtils'
import type { ColorConfig } from './stepItemUtils'
import type { ContextConfig } from './types'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

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
          {showFeedback ? <DataSourceCheckbox
            checked={contextConfig.useFeedback}
            onChange={(checked) => onContextChange({
              ...contextConfig,
              useFeedback: checked,
            })}
            title={t('dataSourceWizard.customerFeedback')}
            description={t('dataSourceWizard.customerFeedbackDescription')}
          /> : null}

          {showPersonas ? <DataSourceCheckbox
            checked={contextConfig.usePersonas}
            onChange={(checked) => onContextChange({
              ...contextConfig,
              usePersonas: checked,
              selectedPersonaIds: checked ? contextConfig.selectedPersonaIds : [],
            })}
            title={t('dataSourceWizard.personasCount', { count: personasCount })}
            description={t('dataSourceWizard.personasDescription')}
          /> : null}

          {combineDocuments && documentsCount > 0 ? <DataSourceCheckbox
            checked={contextConfig.useDocuments || contextConfig.useResearch}
            onChange={(checked) => onContextChange({
              ...contextConfig,
              useDocuments: checked,
              useResearch: checked,
              selectedDocumentIds: checked ? contextConfig.selectedDocumentIds : [],
              selectedResearchIds: checked ? contextConfig.selectedResearchIds : [],
            })}
            title={t('dataSourceWizard.documentsCount', { count: documentsCount })}
            description={t('dataSourceWizard.selectDocumentsToMerge')}
          /> : null}

          {!combineDocuments && showDocuments ? <DataSourceCheckbox
            checked={contextConfig.useDocuments}
            onChange={(checked) => onContextChange({
              ...contextConfig,
              useDocuments: checked,
              selectedDocumentIds: checked ? contextConfig.selectedDocumentIds : [],
            })}
            title={t('dataSourceWizard.existingDocumentsCount', { count: otherDocsCount })}
            description={t('dataSourceWizard.existingDocumentsDescription')}
          /> : null}

          {!combineDocuments && showResearch ? <DataSourceCheckbox
            checked={contextConfig.useResearch}
            onChange={(checked) => onContextChange({
              ...contextConfig,
              useResearch: checked,
              selectedResearchIds: checked ? contextConfig.selectedResearchIds : [],
            })}
            title={t('dataSourceWizard.researchDocumentsCount', { count: researchDocsCount })}
            description={t('dataSourceWizard.researchDescription')}
          /> : null}
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
  readonly categories: ReadonlyArray<{
    id: string;
    name: string
  }>
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
          {sources.map((s) => (
            <button
              key={s}
              onClick={() => onContextChange({
                ...contextConfig,
                sources: toggleArrayItem(contextConfig.sources, s),
              })}
              className={clsx(
                'px-2 sm:px-3 py-2 rounded-lg border text-xs sm:text-sm truncate',
                contextConfig.sources.includes(s) ? `${colors.bgLight} ${colors.border} ${colors.text}` : 'bg-white border-gray-200',
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
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => onContextChange({
                  ...contextConfig,
                  categories: toggleArrayItem(contextConfig.categories, c.id),
                })}
                className={clsx(
                  'px-2 sm:px-3 py-2 rounded-lg border text-xs sm:text-sm truncate',
                  contextConfig.categories.includes(c.id) ? `${colors.bgLight} ${colors.border} ${colors.text}` : 'bg-white border-gray-200',
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
          {SENTIMENTS.map((s) => (
            <button
              key={s}
              onClick={() => onContextChange({
                ...contextConfig,
                sentiments: toggleArrayItem(contextConfig.sentiments, s),
              })}
              className={clsx(
                'px-3 sm:px-4 py-2 rounded-lg border text-sm flex-1 capitalize',
                getSentimentClass(s, contextConfig.sentiments.includes(s), colors),
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
          onChange={(e) => onContextChange({
            ...contextConfig,
            days: +e.target.value,
          })}
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
    onContextChange(buildPersonaToggleConfig(contextConfig, personaId, checked))
  }

  const handleDocumentToggle = (doc: ProjectDocument, checked: boolean) => {
    onContextChange(buildDocToggleConfig(contextConfig, doc, checked))
  }

  const showPersonas = contextConfig.usePersonas && personas.length > 0

  return (
    <div className="space-y-4 sm:space-y-6">
      {showPersonas ? (
        <PersonaSelection
          personas={personas}
          selectedIds={contextConfig.selectedPersonaIds}
          onToggle={handlePersonaToggle}
        />
      ) : null}
      <ItemSelectionDocuments
        contextConfig={contextConfig}
        documents={documents}
        otherDocs={otherDocs}
        researchDocs={researchDocs}
        combineDocuments={combineDocuments}
        onToggle={handleDocumentToggle}
      />
    </div>
  )
}
