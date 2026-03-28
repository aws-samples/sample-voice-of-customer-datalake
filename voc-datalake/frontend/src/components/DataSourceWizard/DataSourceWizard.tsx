/**
 * @fileoverview Data source wizard for context selection.
 * @module components/DataSourceWizard
 */

import clsx from 'clsx'
import {
  X, ChevronLeft, ChevronRight, Loader2,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  DataSourcesStep, FeedbackFiltersStep, ItemSelectionStep,
} from './DataSourceSteps'
import { useWizardState } from './useWizardState'
import type { ContextConfig } from './types'
import type {
  ProjectPersona, ProjectDocument,
} from '../../api/types'

type AccentColor = 'purple' | 'amber' | 'blue' | 'green'

const EMPTY_HIDE_DATA_SOURCES: ReadonlyArray<'feedback' | 'personas' | 'documents' | 'research'> = []

interface DataSourceWizardProps {
  readonly title: string
  readonly accentColor: AccentColor
  readonly icon: React.ReactNode
  readonly personas: ReadonlyArray<ProjectPersona>
  readonly documents: ReadonlyArray<ProjectDocument>
  readonly contextConfig: ContextConfig
  readonly onContextChange: (config: ContextConfig) => void
  readonly renderFinalStep: () => React.ReactNode
  readonly finalStepValid: boolean
  readonly onClose: () => void
  readonly onSubmit: () => void
  readonly isSubmitting: boolean
  readonly submitLabel: React.ReactNode
  readonly hideDataSources?: ReadonlyArray<'feedback' | 'personas' | 'documents' | 'research'>
  readonly combineDocuments?: boolean
}

const colorClasses = {
  purple: {
    bg: 'bg-purple-600',
    bgLight: 'bg-purple-100',
    border: 'border-purple-300',
    text: 'text-purple-700',
    hover: 'hover:bg-purple-700',
  },
  amber: {
    bg: 'bg-amber-600',
    bgLight: 'bg-amber-100',
    border: 'border-amber-300',
    text: 'text-amber-700',
    hover: 'hover:bg-amber-700',
  },
  blue: {
    bg: 'bg-blue-600',
    bgLight: 'bg-blue-100',
    border: 'border-blue-300',
    text: 'text-blue-700',
    hover: 'hover:bg-blue-700',
  },
  green: {
    bg: 'bg-green-600',
    bgLight: 'bg-green-100',
    border: 'border-green-300',
    text: 'text-green-700',
    hover: 'hover:bg-green-700',
  },
}

export default function DataSourceWizard({
  title,
  accentColor,
  icon,
  personas,
  documents,
  contextConfig,
  onContextChange,
  renderFinalStep,
  finalStepValid,
  onClose,
  onSubmit,
  isSubmitting,
  submitLabel,
  hideDataSources = EMPTY_HIDE_DATA_SOURCES,
  combineDocuments = false,
}: DataSourceWizardProps) {
  const {
    step,
    totalSteps,
    stepContent,
    sources,
    categories,
    loadingCategories,
    researchDocs,
    otherDocs,
    showFeedback,
    showPersonas,
    showDocuments,
    showResearch,
    handleBack,
    handleNext,
  } = useWizardState({
    personas,
    documents,
    contextConfig,
    combineDocuments,
    hideDataSources,
  })

  const colors = colorClasses[accentColor]

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4 sm:p-6">
      <div className="bg-white rounded-xl w-full max-w-2xl max-h-[90vh] overflow-hidden">
        <WizardHeader title={title} icon={icon} step={step} totalSteps={totalSteps} onClose={onClose} />
        <ProgressBar step={step} totalSteps={totalSteps} bgClass={colors.bg} />

        <div className="p-4 sm:p-6 overflow-y-auto max-h-[60vh]">
          {stepContent === 'dataSources' && (
            <DataSourcesStep
              contextConfig={contextConfig}
              onContextChange={onContextChange}
              showFeedback={showFeedback}
              showPersonas={showPersonas}
              showDocuments={showDocuments}
              showResearch={showResearch}
              combineDocuments={combineDocuments}
              personasCount={personas.length}
              documentsCount={documents.length}
              otherDocsCount={otherDocs.length}
              researchDocsCount={researchDocs.length}
            />
          )}

          {stepContent === 'feedbackFilters' && (
            <FeedbackFiltersStep
              contextConfig={contextConfig}
              onContextChange={onContextChange}
              sources={sources}
              categories={categories}
              loadingCategories={loadingCategories}
              colors={colors}
            />
          )}

          {stepContent === 'itemSelection' && (
            <ItemSelectionStep
              contextConfig={contextConfig}
              onContextChange={onContextChange}
              personas={personas}
              documents={documents}
              otherDocs={otherDocs}
              researchDocs={researchDocs}
              combineDocuments={combineDocuments}
            />
          )}

          {stepContent === 'final' && renderFinalStep()}
        </div>

        <WizardFooter
          step={step}
          totalSteps={totalSteps}
          colors={colors}
          finalStepValid={finalStepValid}
          isSubmitting={isSubmitting}
          submitLabel={submitLabel}
          onBack={handleBack}
          onNext={handleNext}
          onSubmit={onSubmit}
        />
      </div>
    </div>
  )
}

// Header Component
interface WizardHeaderProps {
  readonly title: string
  readonly icon: React.ReactNode
  readonly step: number
  readonly totalSteps: number
  readonly onClose: () => void
}

function WizardHeader({
  title, icon, step, totalSteps, onClose,
}: WizardHeaderProps) {
  const { t } = useTranslation('components')
  return (
    <div className="flex items-center justify-between p-3 sm:p-4 border-b">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <div className="flex-shrink-0">{icon}</div>
        <div className="min-w-0">
          <h2 className="text-base sm:text-lg font-semibold truncate">{title}</h2>
          <p className="text-xs sm:text-sm text-gray-500">{t('dataSourceWizard.stepOf', {
            step,
            total: totalSteps,
          })}</p>
        </div>
      </div>
      <button
        onClick={onClose}
        className="p-2 hover:bg-gray-100 rounded-lg flex-shrink-0"
        aria-label={t('dataSourceWizard.closeWizard')}
      >
        <X size={20} />
      </button>
    </div>
  )
}

// Progress Bar Component
interface ProgressBarProps {
  readonly step: number
  readonly totalSteps: number
  readonly bgClass: string
}

function ProgressBar({
  step, totalSteps, bgClass,
}: ProgressBarProps) {
  return (
    <div className="h-1 bg-gray-100">
      <div className={clsx('h-full transition-all', bgClass)} style={{ width: `${(step / totalSteps) * 100}%` }} />
    </div>
  )
}

// Footer Component
interface WizardFooterProps {
  readonly step: number
  readonly totalSteps: number
  readonly colors: typeof colorClasses.purple
  readonly finalStepValid: boolean
  readonly isSubmitting: boolean
  readonly submitLabel: React.ReactNode
  readonly onBack: () => void
  readonly onNext: () => void
  readonly onSubmit: () => void
}

function WizardFooter({
  step,
  totalSteps,
  colors,
  finalStepValid,
  isSubmitting,
  submitLabel,
  onBack,
  onNext,
  onSubmit,
}: WizardFooterProps) {
  const { t } = useTranslation('components')
  return (
    <div className="flex justify-between p-3 sm:p-4 border-t bg-gray-50 gap-2">
      <button
        onClick={onBack}
        disabled={step === 1}
        className="flex items-center gap-1 sm:gap-2 px-3 sm:px-4 py-2 text-gray-600 hover:bg-gray-100 active:bg-gray-200 rounded-lg disabled:opacity-50 text-sm sm:text-base"
      >
        <ChevronLeft size={16} className="flex-shrink-0" />
        <span className="hidden sm:inline">{t('dataSourceWizard.back')}</span>
      </button>

      {step < totalSteps ? (
        <button
          onClick={onNext}
          className={clsx('flex items-center gap-1 sm:gap-2 px-3 sm:px-4 py-2 text-white rounded-lg text-sm sm:text-base', colors.bg, colors.hover)}
        >
          <span>{t('dataSourceWizard.next')}</span>
          <ChevronRight size={16} className="flex-shrink-0" />
        </button>
      ) : (
        <button
          onClick={onSubmit}
          disabled={!finalStepValid || isSubmitting}
          className={clsx('flex items-center gap-1 sm:gap-2 px-4 sm:px-6 py-2 text-white rounded-lg disabled:opacity-50 text-sm sm:text-base', colors.bg, colors.hover)}
        >
          {isSubmitting ? (
            <>
              <Loader2 size={16} className="animate-spin flex-shrink-0" />
              <span className="truncate">{t('dataSourceWizard.processing')}</span>
            </>
          ) : (
            submitLabel
          )}
        </button>
      )}
    </div>
  )
}
