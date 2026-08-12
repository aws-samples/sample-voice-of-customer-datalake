/**
 * OverviewTab - Project overview: the six project tools, in dependency order,
 * each reporting whether it has produced anything yet.
 *
 * The card order is Product → Personas → Research → PRD/PR-FAQ → Prototype →
 * Remix, which is the order the generators can actually feed each other (see
 * `overviewState.ts`). It is not the order the cards used to appear in: PRD/PR-FAQ
 * came *before* research, so reading the grid top to bottom produced documents
 * that had neither research nor a deliberate persona selection behind them.
 *
 * Prototype is step 5 rather than a lone button pinned to the right of the tab
 * row, where it read as a tab-level control for something that is really the last
 * artifact in the sequence — and where, unlike here, it could not report that a
 * prototype already existed. It sits before Remix because it needs *one* of
 * PRD/PR-FAQ where Remix needs two documents, and because it produces a new
 * artifact where Remix revises existing ones.
 */
import clsx from 'clsx'
import { format } from 'date-fns'
import {
  Users, FileText, Search, Sparkles, Shuffle, Package, Wand2, AlertCircle, Loader2,
} from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal'
import {
  deriveOverviewState, type OverviewStep, type OverviewStepState,
} from './overviewState'
import { usePrototypeBuild, type PrototypeBuildControl } from './usePrototypeBuild'
import type { ReactNode } from 'react'
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
  /** Tells the Background Jobs panel to pick up a started prototype build. */
  readonly onJobStarted?: () => void
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
  onJobStarted,
}: OverviewTabProps) {
  const { t } = useTranslation('projectDetail')
  const {
    steps, nextStep, prototypeSources,
  } = deriveOverviewState({
    personas,
    documents,
    productContext,
  })

  const prototypeBuild = usePrototypeBuild({
    projectId: project.project_id,
    hasPrd: prototypeSources.hasPrd,
    hasPrfaq: prototypeSources.hasPrfaq,
    hasExistingPrototype: steps.prototype.hasOutput,
    prdOptions: prototypeSources.prdOptions,
    prfaqOptions: prototypeSources.prfaqOptions,
    researchOptions: prototypeSources.researchOptions,
    onJobStarted,
  })

  // Written out as literal t() calls rather than built from the step id: a key
  // assembled at runtime is invisible to the i18n extractor, which is the exact
  // blind spot that left whole surfaces untranslated.
  const nextStepLabels: Record<OverviewStep, string> = {
    product: t('overview.nextStep.product'),
    personas: t('overview.nextStep.personas'),
    research: t('overview.nextStep.research'),
    documents: t('overview.nextStep.documents'),
    prototype: t('overview.nextStep.prototype'),
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
          state={steps.prototype}
          icon={<Wand2 size={20} className="text-orange-600" />}
          iconBg="bg-orange-100"
          // The heading names the artifact ("Clickable Prototype") the way the
          // product card does, so the button underneath can keep the verb — and
          // keep the exact accessible name the tab-row button had, which is what
          // lets the existing gate and handover tests carry over unchanged.
          title={t('overview.prototype')}
          description={t('overview.prototypeDesc')}
          stateLabel={steps.prototype.hasOutput
            ? t('overview.state.prototypes', { total: steps.prototype.count })
            : t('overview.state.prototypesNone')}
          buttonColor="bg-orange-500 hover:bg-orange-600"
          buttonIcon={prototypeBuild.busy
            ? <Loader2 size={16} className="animate-spin" />
            : <Wand2 size={16} />}
          buttonLabel={prototypeBuild.busy
            ? t('documents.prototype.building')
            : t('documents.prototype.button')}
          // No `configureLabel`: the other cards open a wizard to configure first,
          // this one starts the build (or a confirm) directly, so "Configure and"
          // would promise a step that does not exist.
          onClick={prototypeBuild.onClick}
          // Like remix, `missingUpstream` is a hard block here rather than a hint.
          // This is the *user-facing* authority — one derived condition, shared
          // with the state label — while the hook keeps its own guard on the same
          // condition so a caller that forgets to disable cannot start a
          // sourceless billable build. Both are verified load-bearing.
          //
          // `busy` also disables, but it is a SECOND reason, and this card is the
          // only one with two. So the message has to be gated on the reason it
          // actually describes: unconditional, it told a user with a PRD to "create
          // a PRD" for the whole duration of every successful build.
          disabled={steps.prototype.missingUpstream || prototypeBuild.busy}
          disabledMessage={steps.prototype.missingUpstream
            ? t('documents.prototype.needsDocs')
            : undefined}
          // The card has no room for the two lines a build needs: a failure to
          // START (everything after that belongs to the jobs panel) and a brief
          // acknowledgement covering the gap before that panel refetches.
          statusLine={prototypeStatusLine(prototypeBuild, t)}
          // On the card, NOT in the confirm dialog: `confirmKeyFor` deliberately
          // opens no dialog for a project with one PRD, one PR-FAQ and no
          // prototype, so a control placed there would be unreachable for exactly
          // the simplest project — and moving that project behind a fourth confirm
          // reason would cost the deliberate one-click path.
          controls={<PrototypeExtraSources extras={prototypeBuild.extras} t={t} />}
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
          // Remix is the one card where a missing input is a hard block rather
          // than a hint, so it reuses the derived flag instead of restating the
          // two-document rule — one expression of it, in overviewState.
          disabled={steps.remix.missingUpstream}
          disabledMessage={t('overview.needAtLeast2Docs')}
        />
      </div>

      {/* Only reachable from the prototype card, and only when the build needs
          something said first: one of PRD/PR-FAQ missing, a prototype already
          present, or several documents of a type to choose between. The build is
          billable, so which documents it will read is stated before it runs
          rather than after. */}
      <ConfirmModal
        isOpen={prototypeBuild.confirm.isOpen}
        title={t('documents.prototype.button')}
        message={prototypeBuild.confirm.message}
        confirmLabel={t('documents.prototype.confirmBuild')}
        cancelLabel={t('documents.prototype.cancel')}
        variant="warning"
        onConfirm={prototypeBuild.confirm.onConfirm}
        onCancel={prototypeBuild.confirm.onCancel}
      >
        <PrototypeSourcePicker sources={prototypeBuild.sources} t={t} />
      </ConfirmModal>
    </div>
  )
}

/**
 * The prototype card's one extra line: a failure to start, or a brief
 * acknowledgement that a build began.
 *
 * Split out rather than inlined because the card call site is already the longest
 * in the grid, and because an error must win over an acknowledgement — a build
 * that failed to start has not started, and showing both would say otherwise.
 */
function prototypeStatusLine(
  build: PrototypeBuildControl,
  t: TFunction,
): ReactNode {
  // Always returns the region, even with nothing in it, so the <p> stays mounted
  // across the click that fills it. Both texts appear with no focus change and
  // nothing else on screen to signal them, so without a live region a
  // screen-reader user never learns that a billable build failed to start —
  // and a region that mounts at the same moment as its text can be missed
  // entirely.
  //
  // `role="status"` carries an implicit `aria-live="polite"`, so it is not repeated;
  // polite rather than assertive because this line also carries the success
  // acknowledgement. The margin is conditional so an empty region takes no vertical
  // space — otherwise this card would sit lower at rest than the other five.
  const text = prototypeStatusText(build, t)
  return (
    <p className={clsx('text-xs text-center', text != null && 'mt-2')} role="status">
      {text}
    </p>
  )
}

function prototypeStatusText(build: PrototypeBuildControl, t: TFunction): ReactNode {
  // Error first, and load-bearing together with the hook never setting `started`
  // on the failure path: either one alone keeps a failure visible, and it takes
  // removing BOTH for an error to be masked by an acknowledgement.
  if (build.error != null) {
    return (
      <span className="inline-flex items-center gap-1 text-red-600" title={build.error}>
        <AlertCircle size={12} /> {build.error}
      </span>
    )
  }
  if (build.started) return <span className="text-emerald-700">{t('documents.prototype.started')}</span>
  return null
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
  readonly icon: ReactNode
  readonly iconBg: string
  readonly title: string
  readonly description: string
  /** What this step has produced. Omitted when it cannot be known. */
  readonly stateLabel?: string
  /** Shown when an optional upstream input is missing. Advisory, never a block. */
  readonly hint?: string
  /**
   * A transient line about this card's own last action — a failure to start, or an
   * acknowledgement that something began. Only the prototype card starts work
   * directly rather than opening a wizard, so only it has anything to report; the
   * others leave this unset.
   */
  readonly statusLine?: ReactNode
  /**
   * Choices this card's own action reads, rendered above its button. Only the
   * prototype card has any: the other five open a wizard that asks for its
   * configuration, so a control here would duplicate the first wizard step.
   */
  readonly controls?: ReactNode
  readonly buttonColor: string
  readonly buttonIcon: ReactNode
  readonly buttonLabel: string
  /**
   * "Configure & " prefix for cards that open a wizard first. Omitted by cards that
   * act directly — an empty string would read as a translated value that happens to
   * be blank, rather than as "this card has no prefix".
   */
  readonly configureLabel?: string
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
  statusLine,
  controls,
  buttonColor,
  buttonIcon,
  buttonLabel,
  configureLabel,
  onClick,
  disabled,
  disabledMessage,
}: ActionCardProps) {
  return (
    <div className="bg-white rounded-xl p-4 sm:p-6 border">
      <div className="flex items-center gap-3 mb-4">
        <div className={`w-10 h-10 ${iconBg} rounded-lg flex items-center justify-center flex-shrink-0`}>
          {icon}
        </div>
        <div className="min-w-0">
          {/*
            The position is part of the heading text rather than a badge over the
            icon. It reads the same way to everyone — a screen reader announces
            "1. Product / Service Description" — where the badge had to be
            aria-hidden and re-announced from a parallel hidden span, which is the
            tell that it could not carry its own meaning. It also matches the
            wizard, which states its sequence as text ("Step 1 of 4") rather than
            as a numeric chip; no chip idiom exists anywhere else in the app.

            Not translated: a bare ordinal and a period need no catalogue entry,
            and inventing one per locale would be eight strings to maintain for
            punctuation.
          */}
          <h3 className="font-semibold text-sm sm:text-base">
            {/*
              gray-500, not gray-400: on white, #9ca3af is 2.54:1 and #6b7280 is
              4.83:1, so only the latter clears the 4.5:1 minimum for small text.
              It matters more now than it would have before — with the hidden
              counterpart gone, this text is the *only* channel carrying the
              sequence, so making it hard to read would undo the change.
            */}
            <span className="text-gray-500 tabular-nums">{state.position}.</span>{' '}{title}
          </h3>
          <p className="text-xs sm:text-sm text-gray-500">{description}</p>
        </div>
      </div>
      {stateLabel == null ? null : (
        // Both branches clear 4.5:1 on white (green-700 5.02:1, gray-500 4.83:1).
        // "None yet" is information, not decoration, so it has to be readable.
        <p className={`text-xs mb-3 ${state.hasOutput ? 'text-green-700' : 'text-gray-500'}`}>{stateLabel}</p>
      )}
      {/* Above the button, because they change what the button does. Rendered raw
          like `statusLine`: only the caller knows what the choices are, and a
          wrapper here would put an empty box on the five cards that have none. */}
      {controls}
      <button
        onClick={onClick}
        disabled={disabled}
        className={`w-full py-2 text-white rounded-lg flex items-center justify-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed ${buttonColor}`}
      >
        {buttonIcon}
        {configureLabel == null ? null : <span className="hidden sm:inline">{configureLabel}</span>}{buttonLabel}
      </button>
      {hint == null ? null : <p className="text-xs text-amber-700 mt-2 text-center">{hint}</p>}
      {/* Rendered raw, with no wrapper of its own: it sits with `hint` and
          `disabledMessage` because all three explain the button, but the caller
          supplies the whole element. Only the caller knows whether the line is a
          failure or an acknowledgement, and only the one card that starts work
          directly needs it to be a live region — wrapping it here would put an
          empty live region on all six cards. */}
      {statusLine}
      {/* Pre-existing gray-400, raised with the rest: this line explains why a
          button is disabled, which is the last text on the card that should be
          hard to read. */}
      {disabled === true && disabledMessage != null && disabledMessage !== '' ? <p className="text-xs text-gray-500 mt-2 text-center">{disabledMessage}</p> : null}
    </div>
  )
}

/**
 * Which PRD and PR/FAQ the build will read, and a way to change either.
 *
 * A `select` rather than a list of radios: the live case that motivated this has
 * three PR/FAQs and would grow, and a native select is also the control that
 * works on a phone without any of its own keyboard handling.
 *
 * A type with one document renders as a plain line, not a disabled select. There
 * is nothing to choose, but naming it still answers "what will this read", which
 * is half of why the dialog opens at all. A type with none renders nothing —
 * "no PRD" is already the confirm message's whole subject in that case, and
 * repeating it under the sentence that says it would be noise.
 */
function PrototypeSourcePicker({
  sources, t,
}: {
  readonly sources: PrototypeBuildControl['sources']
  readonly t: TFunction<'projectDetail'>
}) {
  // Nothing to say when the project has neither type: the message already reads
  // "create a PRD or a PR-FAQ first".
  if (sources.prdOptions.length === 0 && sources.prfaqOptions.length === 0) return null

  return (
    // `mt-3` lives here rather than on a wrapper in ConfirmModal: this component
    // returns null when there is nothing to choose, and a wrapper's margin would
    // leave a gap the modal cannot detect.
    <div data-testid="prototype-source-picker" className="mt-3 space-y-2 rounded-lg bg-gray-50 p-3">
      <SourceRow
        label={t('documents.prototype.sourcePrd')}
        latestLabel={t('documents.prototype.sourceLatest')}
        options={sources.prdOptions}
        selectedId={sources.prdId}
        onSelect={sources.onSelectPrd}
      />
      <SourceRow
        label={t('documents.prototype.sourcePrfaq')}
        latestLabel={t('documents.prototype.sourceLatest')}
        options={sources.prfaqOptions}
        selectedId={sources.prfaqId}
        onSelect={sources.onSelectPrfaq}
      />
    </div>
  )
}

/** One source slot: a select when there is a choice, a statement when there is not. */
function SourceRow({
  label, latestLabel, options, selectedId, onSelect,
}: {
  readonly label: string
  /** Marks the default option. Passed in so the key stays a literal `t()` call. */
  readonly latestLabel: string
  readonly options: PrototypeBuildControl['sources']['prdOptions']
  readonly selectedId: string
  readonly onSelect: (documentId: string) => void
}) {
  const selectId = useId()
  if (options.length === 0) return null

  const selected = options.find((option) => option.document_id === selectedId)

  if (options.length === 1) {
    return (
      <p className="text-xs text-gray-600">
        <span className="font-medium">{label}</span>{' '}
        <span className="text-gray-500">{selected?.title ?? options[0].title}</span>
      </p>
    )
  }

  return (
    <div className="text-xs">
      {/* A real label, not a bare span: this is the only control in the dialog,
          and a select whose purpose is announced as "combobox" is unusable
          without sight of the text beside it. */}
      <label htmlFor={selectId} className="block font-medium text-gray-600 mb-1">{label}</label>
      <select
        id={selectId}
        value={selectedId}
        onChange={(e) => onSelect(e.target.value)}
        className="w-full px-2 py-1.5 border rounded-lg bg-white text-gray-700"
      >
        {options.map((option, index) => (
          <option key={option.document_id} value={option.document_id}>
            {/* Options are newest first, so index 0 is what the build would use
                with no choice made. Dates disambiguate the same-titled documents
                this picker exists for — six prototypes named "Prototype" is the
                real shape of this data. */}
            {`${option.title} — ${format(new Date(option.created_at), 'MMM d, yyyy')}`}
            {index === 0 ? ` (${latestLabel})` : ''}
          </option>
        ))}
      </select>
    </div>
  )
}

/**
 * The two optional inputs a prototype build can be told to read: the project's
 * product context, and specific research reports.
 *
 * On the card rather than inside `ConfirmModal`, and that placement is the whole
 * design decision: `confirmKeyFor` returns null — no dialog at all — for a project
 * with one PRD, one PR-FAQ and no prototype, deliberately, so that the build starts
 * on the first click. A control living in the dialog would be unreachable for
 * exactly that project.
 *
 * Checkboxes rather than the `select` the source picker uses, because these are
 * independent on/off choices rather than one-of-many, and because the research list
 * is a multi-selection: the same shape `DataSourceSteps` uses, which is also why the
 * research ids stay a separate field from the document ids.
 */
function PrototypeExtraSources({
  extras, t,
}: {
  readonly extras: PrototypeBuildControl['extras']
  readonly t: TFunction<'projectDetail'>
}) {
  return (
    <div data-testid="prototype-extra-sources" className="mb-3 space-y-1.5 rounded-lg bg-gray-50 p-2.5">
      <p className="text-xs font-medium text-gray-600">{t('documents.prototype.extraSources')}</p>
      <SourceCheckbox
        label={t('documents.prototype.useProductContext')}
        checked={extras.useProductContext}
        onChange={extras.onToggleProductContext}
      />
      {/* Nothing to offer, nothing to show — the same reason `SourceRow` renders
          null for a type the project has none of. A checkbox that can only ever
          contribute an empty section is an invitation to a no-op. */}
      {extras.researchOptions.length === 0 ? null : (
        <>
          <SourceCheckbox
            // `total`, not `count`: `count` makes i18next resolve plural
            // suffixes, which would mean two more keys per catalogue for a
            // number that is only ever shown in parentheses. `overview.state.research`
            // already interpolates `total` the same way.
            label={t('documents.prototype.useResearch', { total: extras.researchOptions.length })}
            checked={extras.useResearch}
            onChange={extras.onToggleResearch}
          />
          {extras.useResearch ? (
            <div data-testid="prototype-research-list" className="ml-5 space-y-1 border-l pl-2">
              {extras.researchOptions.map((option) => {
                const checked = extras.selectedResearchIds.includes(option.document_id)
                return (
                  <SourceCheckbox
                    key={option.document_id}
                    label={option.title}
                    checked={checked}
                    // At the bound, the unticked boxes stop accepting: the API
                    // rejects a longer list, and a 400 after the choice is made
                    // says nothing about which report to give up.
                    disabled={!checked && extras.researchLimitReached}
                    onChange={() => extras.onToggleResearchId(option.document_id)}
                  />
                )
              })}
              {extras.researchLimitReached ? (
                <p className="text-xs text-amber-700">
                  {t('documents.prototype.researchLimit', { max: extras.maxResearchIds })}
                </p>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </div>
  )
}

/** One tick-box with a real label, so the whole row is a hit target and an
    accessible name exists without a `title` or an aria-label. */
function SourceCheckbox({
  label, checked, disabled, onChange,
}: {
  readonly label: string
  readonly checked: boolean
  readonly disabled?: boolean
  readonly onChange: (next: boolean) => void
}) {
  return (
    <label className={clsx(
      'flex items-center gap-2 text-xs',
      // gray-500, not gray-400: #6b7280 clears 4.5:1 on white where #9ca3af does
      // not, and the disabled rows are the ones a user most needs to read to
      // understand why they cannot tick them.
      disabled === true ? 'text-gray-500' : 'text-gray-700',
    )}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="rounded border-gray-300"
      />
      <span className="truncate">{label}</span>
    </label>
  )
}
