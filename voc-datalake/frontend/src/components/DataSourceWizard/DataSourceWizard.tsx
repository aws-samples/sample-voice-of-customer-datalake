/**
 * @fileoverview Data source wizard for context selection.
 * @module components/DataSourceWizard
 */

import { X, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import type { ContextConfig } from './types'
import { DataSourcesStep, FeedbackFiltersStep } from './DataSourceSteps'
import { ItemSelectionStep } from './ItemSelectionStep'
import type { ExtraDataSource } from './DataSourceSteps'
import { useWizardState } from './useWizardState'
import ModalShell from '../ModalShell/ModalShell'

interface DataSourceWizardProps {
  readonly title: string
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
  /** Wizard-specific sources appended to the Data Sources step as peer cards. */
  readonly extraDataSources?: ReadonlyArray<ExtraDataSource>
}

// Every wizard is the brand accent: progress bar `bg-accent`, Next/Submit `btn-primary`,
// a selected filter `bg-accent-subtle border-accent` (design-system rules 7 and 15). The
// per-wizard `accentColor` (personas purple, research amber, documents blue, remix green)
// painted WHICH wizard was open as if it were a state — and gave three of them a warn/info/ok
// primary button.

export default function DataSourceWizard({
  title,
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
  hideDataSources = [],
  combineDocuments = false,
  extraDataSources = [],
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

  return (
    <ModalShell
      isOpen
      onClose={onClose}
      ariaLabel={title}
      panelClassName="max-w-2xl max-h-[90vh]"
    >
      <WizardHeader title={title} icon={icon} step={step} totalSteps={totalSteps} onClose={onClose} />
      <ProgressBar step={step} totalSteps={totalSteps} />

      <div className="dialog-body">
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
            extraDataSources={extraDataSources}
          />
        )}

        {stepContent === 'feedbackFilters' && (
          <FeedbackFiltersStep
            contextConfig={contextConfig}
            onContextChange={onContextChange}
            sources={sources}
            categories={categories}
            loadingCategories={loadingCategories}
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
        finalStepValid={finalStepValid}
        isSubmitting={isSubmitting}
        submitLabel={submitLabel}
        onBack={handleBack}
        onNext={handleNext}
        onSubmit={onSubmit}
      />
    </ModalShell>
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

function WizardHeader({ title, icon, step, totalSteps, onClose }: WizardHeaderProps) {
  const { t } = useTranslation('components')
  return (
    <div className="dialog-header justify-between">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <div className="flex-shrink-0">{icon}</div>
        <div className="min-w-0">
          <h2 className="dialog-title">{title}</h2>
          <p className="dialog-description">
            {t('components:dataSourceWizard.stepOf', { step, total: totalSteps })}
          </p>
        </div>
      </div>
      <button 
        onClick={onClose} 
        className="dialog-close flex-shrink-0"
        aria-label={t('components:dataSourceWizard.closeWizard')}
      >
        <X size={16} />
      </button>
    </div>
  )
}

// Progress Bar Component
interface ProgressBarProps {
  readonly step: number
  readonly totalSteps: number
}

function ProgressBar({ step, totalSteps }: ProgressBarProps) {
  return (
    <div className="h-1 shrink-0 bg-border">
      <div className="h-full transition-all bg-accent" style={{ width: `${(step / totalSteps) * 100}%` }} />
    </div>
  )
}

// Footer Component
interface WizardFooterProps {
  readonly step: number
  readonly totalSteps: number
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
  finalStepValid,
  isSubmitting,
  submitLabel,
  onBack,
  onNext,
  onSubmit,
}: WizardFooterProps) {
  const { t } = useTranslation('components')
  return (
    <div className="dialog-footer justify-between">
      <button
        onClick={onBack}
        disabled={step === 1}
        className="btn btn-ghost"
        aria-label={t('dataSourceWizard.back')}
        title={t('dataSourceWizard.back')}
      >
        <ChevronLeft size={16} className="flex-shrink-0" />
        <span className="hidden sm:inline">{t('components:dataSourceWizard.back')}</span>
      </button>
      
      {step < totalSteps ? (
        <button
          onClick={onNext}
          className="btn btn-primary"
        >
          <span>{t('components:dataSourceWizard.next')}</span>
          <ChevronRight size={16} className="flex-shrink-0" />
        </button>
      ) : (
        <button
          onClick={onSubmit}
          disabled={!finalStepValid || isSubmitting}
          className="btn btn-primary px-4 sm:px-6"
        >
          {isSubmitting ? (
            <>
              <Loader2 size={16} className="animate-spin flex-shrink-0" />
              <span className="truncate">{t('components:dataSourceWizard.processing')}</span>
            </>
          ) : (
            submitLabel
          )}
        </button>
      )}
    </div>
  )
}
