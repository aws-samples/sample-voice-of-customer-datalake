/**
 * @fileoverview Step components for the DataSourceWizard.
 * @module components/DataSourceWizard/DataSourceSteps
 */

import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SENTIMENTS } from '../../constants/filters'
import clsx from 'clsx'
import { ALL_TIME_CUSTOM_DAYS } from '../../api/baseUrl'
import type { ContextConfig } from './types'
import { useSentimentLabels } from './sentimentLabels'

/** Time-range choices offered as "Last N days"; a year and all time (0) get their own labels. */
const DAY_RANGE_OPTIONS = [7, 14, 30, 60, 90] as const

type ColorConfig = {
  bg: string
  fg: string
  bgLight: string
  border: string
  text: string
  hover: string
}

// Helper functions
function getSentimentClass(sentiment: string, isSelected: boolean, colors: ColorConfig): string {
  if (!isSelected) return 'bg-bg-elevated border-border'
  if (sentiment === 'positive') return 'bg-ok-subtle border-ok/30 text-ok'
  if (sentiment === 'negative') return 'bg-danger-subtle border-danger/30 text-danger'
  return `${colors.bgLight} ${colors.border} ${colors.text}`
}

function toggleArrayItem(arr: string[], item: string): string[] {
  return arr.includes(item) ? arr.filter(x => x !== item) : [...arr, item]
}

function formatSourceName(source: string): string {
  return source.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}


// Data Source Checkbox Component
interface DataSourceCheckboxProps {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  readonly title: string
  readonly description: string
}

/**
 * Wizard-specific data source card injected by the caller (e.g. the research
 * wizard's public web search). Rendered with the exact same DataSourceCheckbox
 * card as the built-in sources so it reads as a peer data source.
 */
export interface ExtraDataSource {
  readonly key: string
  readonly checked: boolean
  readonly title: string
  readonly description: string
  readonly onChange: (checked: boolean) => void
}

function DataSourceCheckbox({ checked, onChange, title, description }: DataSourceCheckboxProps) {
  return (
    <label className="flex items-center gap-3 p-3 rounded-lg border cursor-pointer hover:bg-bg-hover">
      <input
        type="checkbox"
        checked={checked}
        onChange={e => onChange(e.target.checked)}
        className="w-4 h-4 accent-accent"
      />
      <div>
        <div className="font-medium">{title}</div>
        <div className="text-sm text-muted">{description}</div>
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
  readonly extraDataSources?: ReadonlyArray<ExtraDataSource>
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
  extraDataSources = [],
}: DataSourcesStepProps) {
  const { t } = useTranslation('components')
  return (
    <div className="space-y-4">
      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('components:dataSourceWizard.dataSources')}</h3>
        <p className="text-sm text-muted mb-3 sm:mb-4">{t('components:dataSourceWizard.dataSourcesDescription')}</p>
        <div className="space-y-2">
          {showFeedback && (
            <DataSourceCheckbox
              checked={contextConfig.useFeedback}
              onChange={checked => onContextChange({ ...contextConfig, useFeedback: checked })}
              title={t('components:dataSourceWizard.customerFeedback')}
              description={t('components:dataSourceWizard.customerFeedbackDescription')}
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
              title={t('components:dataSourceWizard.personasCount', { count: personasCount })}
              description={t('components:dataSourceWizard.personasDescription')}
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
              title={t('components:dataSourceWizard.documentsCount', { count: documentsCount })}
              description={t('components:dataSourceWizard.selectDocumentsToMerge')}
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
              title={t('components:dataSourceWizard.existingDocumentsCount', { count: otherDocsCount })}
              description={t('components:dataSourceWizard.existingDocumentsDescription')}
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
              title={t('components:dataSourceWizard.researchDocumentsCount', { count: researchDocsCount })}
              description={t('components:dataSourceWizard.researchDescription')}
            />
          )}

          {extraDataSources.map(source => (
            <DataSourceCheckbox
              key={source.key}
              checked={source.checked}
              onChange={source.onChange}
              title={source.title}
              description={source.description}
            />
          ))}
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
  const sentimentLabels = useSentimentLabels()
  return (
    <div className="space-y-4 sm:space-y-6">
      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('components:dataSourceWizard.sources')}</h3>
        <p className="text-sm text-muted mb-2">{t('components:dataSourceWizard.leaveEmptyForAllSources')}</p>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {sources.map(s => (
            <button
              key={s}
              onClick={() => onContextChange({ ...contextConfig, sources: toggleArrayItem(contextConfig.sources, s) })}
              className={clsx(
                'px-2 sm:px-3 py-2 rounded-lg border text-xs sm:text-sm truncate',
                contextConfig.sources.includes(s) ? `${colors.bgLight} ${colors.border} ${colors.text}` : 'bg-bg-elevated border-border'
              )}
            >
              {formatSourceName(s)}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('components:dataSourceWizard.categories')}</h3>
        {loadingCategories ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 size={20} className="animate-spin text-muted" />
            <span className="ml-2 text-sm text-muted">{t('components:dataSourceWizard.loadingCategories')}</span>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {categories.map(c => (
              <button
                key={c.id}
                onClick={() => onContextChange({ ...contextConfig, categories: toggleArrayItem(contextConfig.categories, c.id) })}
                className={clsx(
                  'px-2 sm:px-3 py-2 rounded-lg border text-xs sm:text-sm truncate',
                  contextConfig.categories.includes(c.id) ? `${colors.bgLight} ${colors.border} ${colors.text}` : 'bg-bg-elevated border-border'
                )}
              >
                {c.name}
              </button>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('components:dataSourceWizard.sentiments')}</h3>
        <div className="flex flex-col sm:flex-row gap-2">
          {SENTIMENTS.map(s => (
            <button
              key={s}
              onClick={() => onContextChange({ ...contextConfig, sentiments: toggleArrayItem(contextConfig.sentiments, s) })}
              className={clsx(
                'px-3 sm:px-4 py-2 rounded-lg border text-sm flex-1',
                getSentimentClass(s, contextConfig.sentiments.includes(s), colors)
              )}
            >
              {sentimentLabels[s]}
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="font-medium mb-2 sm:mb-3">{t('components:dataSourceWizard.timeRange')}</h3>
        <select
          value={contextConfig.days}
          onChange={e => onContextChange({ ...contextConfig, days: +e.target.value })}
          className="select py-2.5 sm:py-2"
        >
          {DAY_RANGE_OPTIONS.map(days => (
            <option key={days} value={days}>
              {t('components:dataSourceWizard.lastDays', { days })}
            </option>
          ))}
          <option value={365}>{t('components:dataSourceWizard.lastYear')}</option>
          <option value={ALL_TIME_CUSTOM_DAYS}>{t('components:dataSourceWizard.allTime')}</option>
        </select>
      </div>
    </div>
  )
}