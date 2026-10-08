/**
 * @fileoverview Data source wizard for context selection.
 * @module components/DataSourceWizard
 */

import { X, ChevronLeft, ChevronRight, Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProjectDocument } from '../../api/types'
import type { ProjectPersona } from '../../api/projectTypes'
import clsx from 'clsx'
import type { ContextConfig } from './types'
import { DataSourcesStep, FeedbackFiltersStep } from './DataSourceSteps'
import { ItemSelectionStep } from './ItemSelectionStep'
import type { ExtraDataSource } from './DataSourceSteps'
import { useWizardState } from './useWizardState'
import ModalShell from '../ModalShell/ModalShell'
import type { Tone } from '../../theme/tones'

type AccentColor = Extract<Tone, 'accent' | 'warn' | 'info' | 'ok'>

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
  /** Wizard-specific sources appended to the Data Sources step as peer cards. */
  readonly extraDataSources?: ReadonlyArray<ExtraDataSource>
}

const colorClasses = {
  // Caller-facing names are legacy hues; each maps to a semantic token by meaning:
  // purple = brand primary, amber = warn, blue = info, green = ok.
  accent: { bg: 'bg-accent', fg: 'text-accent-fg', bgLight: 'bg-accent-subtle', border: 'border-accent/30', text: 'text-accent-text', hover: 'hover:bg-accent-hover' },
  warn: { bg: 'bg-warn', fg: 'text-warn-fg', bgLight: 'bg-warn-subtle', border: 'border-warn/30', text: 'text-warn', hover: 'hover:bg-warn/90' },
  info: { bg: 'bg-info', fg: 'text-info-fg', bgLight: 'bg-info-subtle', border: 'border-info/30', text: 'text-info', hover: 'hover:bg-info/90' },
  ok: { bg: 'bg-ok', fg: 'text-ok-fg', bgLight: 'bg-ok-subtle', border: 'border-ok/30', text: 'text-ok', hover: 'hover:bg-ok/90' },
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

  const colors = colorClasses[accentColor]

  return (
    <ModalShell
      isOpen
      onClose={onClose}
      ariaLabel={title}
      panelClassName="max-w-2xl max-h-[90vh]"
    >
      <WizardHeader title={title} icon={icon} step={step} totalSteps={totalSteps} onClose={onClose} />
      <ProgressBar step={step} totalSteps={totalSteps} bgClass={colors.bg} />

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
  readonly bgClass: string
}

function ProgressBar({ step, totalSteps, bgClass }: ProgressBarProps) {
  return (
    <div className="h-1 shrink-0 bg-border">
      <div className={clsx('h-full transition-all', bgClass)} style={{ width: `${(step / totalSteps) * 100}%` }} />
    </div>
  )
}

// Footer Component
interface WizardFooterProps {
  readonly step: number
  readonly totalSteps: number
  readonly colors: typeof colorClasses.accent
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
          className={clsx('btn border-transparent', colors.bg, colors.fg, colors.hover)}
        >
          <span>{t('components:dataSourceWizard.next')}</span>
          <ChevronRight size={16} className="flex-shrink-0" />
        </button>
      ) : (
        <button
          onClick={onSubmit}
          disabled={!finalStepValid || isSubmitting}
          className={clsx('btn border-transparent px-4 sm:px-6', colors.bg, colors.fg, colors.hover)}
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
