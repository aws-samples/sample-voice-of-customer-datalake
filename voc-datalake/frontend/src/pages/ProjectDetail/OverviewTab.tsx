/**
 * OverviewTab - Project overview: the five project tools, in dependency order,
 * each reporting whether it has produced anything yet.
 *
 * The card order is Product → Personas → Research → PRD/PR-FAQ → Remix, which is
 * the order the generators can actually feed each other (see `overviewState.ts`).
 * It is not the order the cards used to appear in: PRD/PR-FAQ came *before*
 * research, so reading the grid top to bottom produced documents that had neither
 * research nor a deliberate persona selection behind them.
 */
import {
  Users, FileText, Search, Sparkles, Shuffle, Package,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'
import KiroExportSettings from './KiroExportSettings'
import {
  deriveOverviewState, REMIX_MIN_DOCUMENTS, type OverviewStep, type OverviewStepState,
} from './overviewState'
import type { TFunction } from 'i18next'
import type {
  ProjectPersona, ProjectDocument, Project, ProductContext,
} from '../../api/types'

interface OverviewTabProps {
  readonly project: Project
  readonly personas: ProjectPersona[]
  readonly documents: ProjectDocument[]
  /** Undefined while loading, or if the request failed — the card then shows no state. */
  readonly productContext?: ProductContext
  readonly onGeneratePersonas: () => void
  readonly onGenerateDoc: () => void
  readonly onRunResearch: () => void
  readonly onRemixDocuments: () => void
  readonly onOpenProductTool: () => void
  readonly onSaveKiroPrompt: (prompt: string) => void
}

export default function OverviewTab({
  project,
  personas,
  documents,
  productContext,
  onGeneratePersonas,
  onGenerateDoc,
  onRunResearch,
  onRemixDocuments,
  onOpenProductTool,
  onSaveKiroPrompt,
}: OverviewTabProps) {
  const { t } = useTranslation('projectDetail')
  const {
    steps, nextStep,
  } = deriveOverviewState({
    personas,
    documents,
    productContext,
  })

  // Written out as literal t() calls rather than built from the step id: a key
  // assembled at runtime is invisible to the i18n extractor, which is the exact
  // blind spot that left whole surfaces untranslated.
  const nextStepLabels: Record<OverviewStep, string> = {
    product: t('overview.nextStep.product'),
    personas: t('overview.nextStep.personas'),
    research: t('overview.nextStep.research'),
    documents: t('overview.nextStep.documents'),
    remix: t('overview.nextStep.remix'),
  }

  return (
    <div className="space-y-6">
      {nextStep == null ? null : (
        <p className="text-sm text-gray-600 bg-blue-50 border border-blue-100 rounded-lg px-4 py-2.5">
          <span className="font-medium text-gray-800">{t('overview.nextStepLabel')}</span>{' '}
          {nextStepLabels[nextStep]}
        </p>
      )}

      {/* Action Cards, in dependency order. The testid is what lets a test assert
          that order without also picking up the export card's heading below. */}
      <div data-testid="overview-cards" className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <ActionCard
          state={steps.product}
          icon={<Package size={20} className="text-indigo-600" />}
          iconBg="bg-indigo-100"
          title={t('overview.productDescription')}
          description={t('overview.productDescriptionDesc')}
          stateLabel={productContextStateLabel(steps.product, t)}
          buttonColor="bg-indigo-600 hover:bg-indigo-700"
          buttonIcon={<Package size={16} />}
          buttonLabel={t('overview.openProductTool')}
          configureLabel=""
          onClick={onOpenProductTool}
        />
        <ActionCard
          state={steps.personas}
          icon={<Users size={20} className="text-purple-600" />}
          iconBg="bg-purple-100"
          title={t('overview.generatePersonas')}
          description={t('overview.generatePersonasDesc')}
          stateLabel={steps.personas.hasOutput
            ? t('overview.state.personas', { total: steps.personas.count })
            : t('overview.state.personasNone')}
          buttonColor="bg-purple-600 hover:bg-purple-700"
          buttonIcon={<Sparkles size={16} />}
          buttonLabel={t('overview.generate')}
          configureLabel={t('overview.configureAnd')}
          onClick={onGeneratePersonas}
        />
        <ActionCard
          state={steps.research}
          icon={<Search size={20} className="text-amber-600" />}
          iconBg="bg-amber-100"
          title={t('overview.runResearch')}
          description={t('overview.runResearchDesc')}
          stateLabel={steps.research.hasOutput
            ? t('overview.state.research', { total: steps.research.count })
            : t('overview.state.researchNone')}
          hint={steps.research.missingUpstream ? t('overview.hint.researchNeedsPersonas') : undefined}
          buttonColor="bg-amber-600 hover:bg-amber-700"
          buttonIcon={<Search size={16} />}
          buttonLabel={t('overview.runResearch')}
          configureLabel={t('overview.configureAnd')}
          onClick={onRunResearch}
        />
        <ActionCard
          state={steps.documents}
          icon={<FileText size={20} className="text-blue-600" />}
          iconBg="bg-blue-100"
          title={t('overview.generatePrdPrfaq')}
          description={t('overview.generatePrdPrfaqDesc')}
          stateLabel={steps.documents.hasOutput
            ? t('overview.state.documents', { total: steps.documents.count })
            : t('overview.state.documentsNone')}
          hint={steps.documents.missingUpstream ? t('overview.hint.documentsNeedContext') : undefined}
          buttonColor="bg-blue-600 hover:bg-blue-700"
          buttonIcon={<FileText size={16} />}
          buttonLabel={t('overview.generate')}
          configureLabel={t('overview.configureAnd')}
          onClick={onGenerateDoc}
        />
        <ActionCard
          state={steps.remix}
          icon={<Shuffle size={20} className="text-green-600" />}
          iconBg="bg-green-100"
          title={t('overview.remixDocuments')}
          description={t('overview.remixDocumentsDesc')}
          buttonColor="bg-green-600 hover:bg-green-700"
          buttonIcon={<Shuffle size={16} />}
          buttonLabel={t('overview.selectAndRemix')}
          configureLabel={t('overview.configureAnd')}
          onClick={onRemixDocuments}
          disabled={documents.length < REMIX_MIN_DOCUMENTS}
          disabledMessage={t('overview.needAtLeast2Docs')}
        />
      </div>

      {/* Kiro Export Settings */}
      <KiroExportSettings project={project} onSave={onSaveKiroPrompt} />
    </div>
  )
}

/**
 * The product card is the only one measured in fields rather than artifacts, and
 * the only one that can be in a third state: unknown, while the context request
 * is in flight or after it failed. Unknown renders nothing — a card that cannot
 * tell should not claim the description is empty.
 */
function productContextStateLabel(state: OverviewStepState, t: TFunction): string | undefined {
  if (state.filled == null) return undefined
  if (state.filled === 0) return t('overview.state.productEmpty')
  return t('overview.state.product', {
    filled: state.filled,
    total: state.total,
  })
}

interface ActionCardProps {
  readonly state: OverviewStepState
  readonly icon: React.ReactNode
  readonly iconBg: string
  readonly title: string
  readonly description: string
  /** What this step has produced. Omitted when it cannot be known. */
  readonly stateLabel?: string
  /** Shown when an optional upstream input is missing. Advisory, never a block. */
  readonly hint?: string
  readonly buttonColor: string
  readonly buttonIcon: React.ReactNode
  readonly buttonLabel: string
  readonly configureLabel: string
  readonly onClick: () => void
  readonly disabled?: boolean
  readonly disabledMessage?: string
}

function ActionCard({
  state,
  icon,
  iconBg,
  title,
  description,
  stateLabel,
  hint,
  buttonColor,
  buttonIcon,
  buttonLabel,
  configureLabel,
  onClick,
  disabled,
  disabledMessage,
}: ActionCardProps) {
  const { t } = useTranslation('projectDetail')
  // The visual badge is decorative, so the sequence has to reach assistive
  // technology some other way: as the first thing inside the card's heading.
  const stepNumberLabel = t('overview.stepNumber', { position: state.position })

  return (
    <div className="bg-white rounded-xl p-4 sm:p-6 border">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 ${iconBg} rounded-lg flex items-center justify-center flex-shrink-0 relative`}>
          {icon}
          {/* Decorative here: the position is announced from inside the heading
              below, so repeating it would read the number twice. */}
          <span
            aria-hidden="true"
            className="absolute -top-1.5 -left-1.5 w-5 h-5 rounded-full bg-gray-800 text-white text-[10px] font-semibold flex items-center justify-center"
          >
            {state.position}
          </span>
        </div>
        <div className="min-w-0">
          <h3 className="font-semibold text-sm sm:text-base">
            <span className="sr-only">{stepNumberLabel}</span>
            {title}
          </h3>
          <p className="text-xs sm:text-sm text-gray-500">{description}</p>
        </div>
      </div>
      {stateLabel == null ? null : (
        <p className={`text-xs mb-3 ${state.hasOutput ? 'text-green-700' : 'text-gray-400'}`}>{stateLabel}</p>
      )}
      <button
        onClick={onClick}
        disabled={disabled}
        className={`w-full py-2 text-white rounded-lg flex items-center justify-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed ${buttonColor}`}
      >
        {buttonIcon}
        <span className="hidden sm:inline">{configureLabel}</span>{buttonLabel}
      </button>
      {hint == null ? null : <p className="text-xs text-amber-700 mt-2 text-center">{hint}</p>}
      {disabled === true && disabledMessage != null && disabledMessage !== '' ? <p className="text-xs text-gray-400 mt-2 text-center">{disabledMessage}</p> : null}
    </div>
  )
}
