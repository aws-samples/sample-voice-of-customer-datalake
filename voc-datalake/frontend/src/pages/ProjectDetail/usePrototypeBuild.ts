/**
 * usePrototypeBuild — the Build Prototype flow with no presentation attached.
 *
 * Extracted from `BuildPrototypeButton`, which owned both the flow and its own
 * bespoke button. The control now renders as step 5 of the Overview card grid
 * instead of a lone button pinned to the right of the project tab row, and an
 * `ActionCard` has no room for a spinner, an error line and a confirm dialog — so
 * the state moved here and the card supplies the chrome.
 *
 * What this hook does NOT own, deliberately:
 * - **Whether the step is available.** That is `overviewState`'s
 *   `steps.prototype.missingUpstream` (no PRD and no PR-FAQ), derived in one place
 *   for the card's disabled state. `runBuild` re-checks it as a guard rather than
 *   as the source of truth, so calling this hook from a control that forgot to
 *   disable itself cannot start a sourceless build.
 * - **Progress, success and failure.** Once the job is started, the Background
 *   Jobs panel owns it — it renders status, progress and staleness for exactly
 *   these records and survives tab switches, which is why the previous
 *   await-in-component version reported a still-running build as failed at the
 *   five-minute mark. Only a failure to *start* surfaces here.
 *
 * The backend references the project's latest PRD *and* PR-FAQ: both if both
 * exist, otherwise whichever one does. So one document is enough to build, and
 * when only one is present the user is told which before it runs.
 */
import { useCallback, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { MAX_SELECTED_PRODUCT_DOC_IDS, MAX_SELECTED_RESEARCH_IDS } from './overviewState'
import { useTransientFlag } from './useTransientFlag'
import type { PrototypeSourceOption, PrototypeVisualOption } from './overviewState'

/** Exactly one of the two source documents exists, so the build needs a confirm. */
function hasOnlyOneDoc(hasPrd: boolean, hasPrfaq: boolean): boolean {
  return hasPrd !== hasPrfaq
}

/**
 * The confirm this build needs, or null to start immediately.
 *
 * One function rather than a `needsConfirm` boolean beside a separate message
 * expression: those were two readings of the same state and could have disagreed,
 * leaving a dialog open with the wrong text or no dialog at all.
 *
 * Rebuild outranks the single-document note when both apply — spending money on a
 * duplicate is the more consequential surprise of the two.
 */
/** One of the three confirm keys — not `string`, so a typo cannot compile. */
type WarningKey = (typeof WARNING_MESSAGE)[keyof typeof WARNING_MESSAGE]

function warningKeyFor(
  hasPrd: boolean,
  hasPrfaq: boolean,
  hasExistingPrototype: boolean,
  hasChoice: boolean,
): WarningKey | null {
  if (hasExistingPrototype) return WARNING_MESSAGE.rebuild
  if (hasOnlyOneDoc(hasPrd, hasPrfaq)) return WARNING_MESSAGE[hasPrd ? 'prd' : 'prfaq']
  // More than one document of a type exists, so "the latest" is a decision rather
  // than the only option — stop and name what will be read. Deliberately NOT
  // raised when there is exactly one of each: the dialog would present a choice
  // that has one possible answer, and the build has always started on the first
  // click in that case.
  if (hasChoice) return WARNING_MESSAGE.choose
  return null
}

// Keyed rather than branched in a helper, so the i18n extractor still sees every
// key literally — a key assembled at runtime is invisible to it, which is the
// blind spot that has left whole surfaces untranslated here before.
//
// No `defaultValue`s, matching the rest of this feature: the test harness loads the
// real `en` catalogue, so a key that is missing or has moved renders its raw path
// and fails a test. A `defaultValue` hides exactly that, which is how buttons once
// shipped announcing `editForm` to assistive tech.
const WARNING_MESSAGE = {
  prd: 'documents.prototype.confirmPrdOnly',
  prfaq: 'documents.prototype.confirmPrfaqOnly',
  // A prototype already exists. This is the one that costs money to get wrong: the
  // build endpoint has no existing-prototype check, so a second click starts
  // another multi-minute billable build and keeps the first.
  rebuild: 'documents.prototype.confirmRebuild',
  // Several documents of a type exist, so which ones are read is a choice the user
  // has never been shown. Ranked below the two above because they warn about cost
  // and missing input; this one only needs to be seen, and the picker is rendered
  // beside whichever message wins.
  choose: 'documents.prototype.confirmChooseSources',
} as const

export interface PrototypeBuildControl {
  /** Starts the build, or opens the confirm first when only one source document exists. */
  readonly onClick: () => void
  /** True while the start request is in flight. */
  readonly busy: boolean
  /** Set only when the job failed to START; everything after that is the jobs panel's. */
  readonly error: string | null
  /** True briefly after a successful start, covering the gap before the panel refetches. */
  readonly started: boolean
  /**
   * State for the build wizard — where this build is configured and started.
   *
   * `isOpen` is owned by the hook and changes only on an explicit user action, so
   * the selections inside survive a document refetch. `warning` is independent of
   * it: live-derived, and empty when nothing needs saying, which is why a caller
   * renders it conditionally rather than assuming an open panel has a warning.
   */
  readonly wizard: {
    readonly isOpen: boolean
    /** '' when this build needs no caution. Never gates the panel. */
    readonly warning: string
    readonly onConfirm: () => void
    readonly onCancel: () => void
  }
  /**
   * The documents this build will read, and how to change them. Empty option
   * lists mean there is nothing to choose, so a caller can render the picker
   * on `options.length > 1` without a second condition.
   */
  readonly sources: {
    readonly prdOptions: ReadonlyArray<PrototypeSourceOption>
    readonly prfaqOptions: ReadonlyArray<PrototypeSourceOption>
    /** '' when the project has none of that type. */
    readonly prdId: string
    readonly prfaqId: string
    readonly onSelectPrd: (documentId: string) => void
    readonly onSelectPrfaq: (documentId: string) => void
  }
  /**
   * The optional inputs, all off/empty by default so a build that touches nothing
   * here sends the request it always did: the product-context flag, the research
   * flag-and-list pair, and the visual list (which has no flag — see
   * `selectedVisualIds`).
   *
   * These live in the build wizard, beside the PRD/PR-FAQ pickers, so one panel
   * answers the whole "what should this build read?" question and the card keeps
   * the single button its five siblings have.
   *
   * They used to sit on the card face, because the dialog that existed then opened
   * for only some projects and a control inside it was unreachable for the rest.
   * That constraint is gone: the wizard opens for every project, which is the
   * property `OverviewTab.prototypeWizard.test.tsx` exists to hold.
   */
  readonly extras: {
    readonly useProductContext: boolean
    readonly onToggleProductContext: (next: boolean) => void
    readonly useResearch: boolean
    readonly onToggleResearch: (next: boolean) => void
    /** Newest first, as `overviewState` derives them. Empty means nothing to offer. */
    readonly researchOptions: ReadonlyArray<PrototypeSourceOption>
    /** Only ids still on offer — a report deleted under the card is never sent. */
    readonly selectedResearchIds: ReadonlyArray<string>
    readonly onToggleResearchId: (documentId: string) => void
    /**
     * True when no further report can be added. The API rejects an over-long
     * list, so the control refuses at the bound instead of letting the build fail
     * on submit.
     */
    readonly researchLimitReached: boolean
    readonly maxResearchIds: number
    /**
     * The uploaded visuals on offer — ready images only, as `overviewState`
     * filters them. Empty means nothing to offer, so the caller can render on
     * `length > 0` without a second condition.
     */
    readonly visualOptions: ReadonlyArray<PrototypeVisualOption>
    /**
     * The visuals this build will be grounded in, IN THE ORDER THEY WERE TICKED,
     * and only those still on offer.
     *
     * There is no `useVisuals` flag beside this list, and that is the API's shape
     * rather than an omission here: a non-empty list IS the request. A flag would
     * admit a "flag on, empty list" state that means nothing and a "flag off, ids
     * present" state that needs a convention nobody reading the request body can
     * see — the argument `_validated_product_doc_ids` makes in
     * `lambda/api/projects_handler.py`.
     *
     * Tick order, not option order: the generator's prompt tells the model that
     * where two visuals disagree the FIRST one wins, so the order is a ranking the
     * user expressed and re-sorting it would silently re-rank their choice.
     */
    readonly selectedVisualIds: ReadonlyArray<string>
    readonly onToggleVisualId: (docId: string) => void
    /**
     * True when no further visual can be added. Same reason as research: the API
     * rejects an over-long list, and a 400 arrives after the choice was made.
     */
    readonly visualLimitReached: boolean
    readonly maxVisualIds: number
    /**
     * Uploaded images still extracting, so not selectable YET — reported, not
     * hidden.
     */
    readonly visualsExtracting: number
    /**
     * Uploaded images whose extraction FAILED, so never selectable. Separate from
     * the count above because waiting fixes one and never fixes the other.
     */
    readonly visualsFailed: number
  }
}

export function usePrototypeBuild({
  projectId, hasPrd, hasPrfaq, hasExistingPrototype, prdOptions = [], prfaqOptions = [],
  researchOptions = [], visualOptions = [], visualsExtracting = 0, visualsFailed = 0,
  onJobStarted,
}: {
  readonly projectId: string
  readonly hasPrd: boolean
  readonly hasPrfaq: boolean
  /**
   * The candidate documents of each type, NEWEST FIRST, as `overviewState`
   * derives them. `[0]` is the default, and it must be the same document the
   * backend's latest-of-type would pick — see `sourceOptions` there.
   *
   * Defaulted to empty so the hook still works for a caller that does not offer a
   * choice: the request then names no ids and the backend resolves as it always
   * did.
   */
  readonly prdOptions?: ReadonlyArray<PrototypeSourceOption>
  readonly prfaqOptions?: ReadonlyArray<PrototypeSourceOption>
  /**
   * The project's research reports, newest first. Optional and empty-defaulted:
   * a caller that offers no research selection sends no research ids, and the
   * build reads none — today's behaviour.
   */
  readonly researchOptions?: ReadonlyArray<PrototypeSourceOption>
  /**
   * The project's selectable visuals — ready images only, already filtered by
   * `overviewState`. Optional and empty-defaulted for the same reason as the
   * research list: a caller that offers no visual selection sends no visual ids,
   * and the build reads none.
   */
  readonly visualOptions?: ReadonlyArray<PrototypeVisualOption>
  /**
   * Uploaded images still extracting, and uploaded images whose extraction
   * failed, passed through for the UI's two notes.
   *
   * Two numbers rather than one, because a single "not ready" count could only be
   * worded one way and one of the two wordings is always wrong: "still being
   * processed" about a `failed` doc says it will resolve, and it will not.
   */
  readonly visualsExtracting?: number
  readonly visualsFailed?: number
  /**
   * The project already has a prototype, so this build makes an additional one.
   *
   * Required, not optional-defaulting-false: this is the only thing standing between
   * a stray second click and another multi-minute billable build, and a guard that a
   * future call site can silently omit is not a guard. One caller today, so making
   * it mandatory costs nothing.
   */
  readonly hasExistingPrototype: boolean
  /** Tells the Background Jobs panel to pick the new job up. */
  readonly onJobStarted?: () => void
}): PrototypeBuildControl {
  const { t, i18n } = useTranslation('projectDetail')
  // The chosen source documents. Held as an OVERRIDE rather than as the selection
  // itself, so the effective choice below can fall back to the current newest.
  // Storing the resolved id instead would pin a stale default: the list refetches
  // when a job completes, and a document generated meanwhile must become the
  // default rather than leaving the card aimed at yesterday's newest.
  const [chosenPrdId, setChosenPrdId] = useState('')
  const [chosenPrfaqId, setChosenPrfaqId] = useState('')
  // The two optional inputs, per build. Not persisted and not remembered per
  // project — the same answer #320 took for the source ids, and answering it
  // differently for the two halves of one control would be worse than either.
  const [useProductContext, setUseProductContext] = useState(false)
  const [useResearch, setUseResearch] = useState(false)
  // The reports the user has ticked. Filtered against the live options below
  // rather than pruned on change, for the same reason `effectiveSourceId` falls
  // back: the document list refetches when a job completes, so a chosen report
  // can be deleted under an open card, and an id the API cannot resolve is a 4xx.
  const [chosenResearchIds, setChosenResearchIds] = useState<ReadonlyArray<string>>([])
  // The visuals the user has ticked, in tick order. Filtered against the live
  // options below for the same reason the reports are: the Product tab can delete
  // an upload while this card is open, and the API rejects an id it cannot resolve.
  //
  // No `useVisuals` boolean beside it, deliberately — the API has no such field, so
  // inventing one here would be UI state with nothing to send it to, and the two
  // could then disagree about what the build reads.
  const [chosenVisualIds, setChosenVisualIds] = useState<ReadonlyArray<string>>([])
  const [busy, setBusy] = useState(false)
  // Lowers itself: the panel takes over, so the line must not outlive the gap.
  const started = useTransientFlag()
  const [error, setError] = useState<string | null>(null)
  // Whether the build wizard is on screen. A bare boolean is correct here, unlike
  // in the dialog this replaces — the reasoning is at the `wizard` return value.
  const [isOpen, setIsOpen] = useState(false)

  // The effective choice: what the user picked if that document is still offered,
  // otherwise the newest of the type. A selection whose document has been deleted
  // silently reverts to the default rather than sending an id the API would reject.
  const prdId = effectiveSourceId(prdOptions, chosenPrdId)
  const prfaqId = effectiveSourceId(prfaqOptions, chosenPrfaqId)

  // Only reports still on offer. A stale id would be rejected by the API, which
  // would turn someone else's deletion into this build's failure.
  // Sliced as well as filtered, and the slice is not belt-and-braces — the stored
  // list can genuinely exceed the bound. `toggleWithinBound` counts only ids still
  // ON OFFER, so an id that leaves the options list stops being counted while it
  // stays in state: tick the maximum, have one leave, tick a replacement, and the
  // one that left comes back. For research that needs a deletion and a restore; for
  // visuals it needs neither, because a doc that re-enters `extracting` leaves the
  // options and returns `ready` on its own.
  //
  // The slice is what makes the invariant hold at the only place it matters — the
  // request — rather than depending on every path into state. Pruning state when the
  // options change would need an effect, and `react-hooks/set-state-in-effect` is an
  // error in this repo. The inherited path in DocumentsTab already slices for the
  // sibling reason (a bound that is LOWERED later), so both paths now agree.
  const selectedResearchIds = useMemo(
    () => chosenResearchIds
      .filter((id) => isOfferedResearch(researchOptions, id))
      .slice(0, MAX_SELECTED_RESEARCH_IDS),
    [chosenResearchIds, researchOptions],
  )

  // Only visuals still on offer, in tick order, and never more than the bound —
  // same two reasons as the reports above. The filter stops an upload deleted from
  // the Product tab under this card becoming this build's 400; the slice stops a
  // visual that merely re-extracted and came back doing the same thing.
  //
  // ⚠️ THIS IS ALSO WHAT THE TICK-BOXES RENDER FROM, so a box shows what will be
  // SENT, not what is stored. In the re-extraction case above that means the id
  // beyond the bound visibly un-ticks itself once its doc returns `ready`. That is
  // deliberate: honest about the request, where showing it ticked would promise a
  // grounding the build will not have. Do NOT "fix" it by exposing
  // `chosenVisualIds` instead — that is the state the slice exists to not trust.
  const selectedVisualIds = useMemo(
    () => chosenVisualIds
      .filter((id) => isOfferedVisual(visualOptions, id))
      .slice(0, MAX_SELECTED_PRODUCT_DOC_IDS),
    [chosenVisualIds, visualOptions],
  )

  const onToggleResearch = useCallback((next: boolean) => {
    setUseResearch(next)
    // Ticking pre-selects the reports on offer, newest first, up to the bound the
    // API enforces; unticking clears them rather than remembering a selection the
    // build will not use. Same shape as `DataSourceSteps`, which sets
    // `selectedResearchIds: checked ? … : []` on the same toggle.
    setChosenResearchIds(next
      ? researchOptions.slice(0, MAX_SELECTED_RESEARCH_IDS).map((option) => option.document_id)
      : [])
  }, [researchOptions])

  const onToggleResearchId = useCallback((documentId: string) => {
    setChosenResearchIds((current) => toggleWithinBound(
      current,
      documentId,
      (id) => isOfferedResearch(researchOptions, id),
      MAX_SELECTED_RESEARCH_IDS,
    ))
  }, [researchOptions])

  const onToggleVisualId = useCallback((docId: string) => {
    // Appended, never sorted: this is the precedence order the prompt reads.
    setChosenVisualIds((current) => toggleWithinBound(
      current,
      docId,
      (id) => isOfferedVisual(visualOptions, id),
      MAX_SELECTED_PRODUCT_DOC_IDS,
    ))
  }, [visualOptions])

  // THREE things worth saying before a build runs: only one of PRD/PR-FAQ exists, a
  // prototype already does (so this one costs money for a duplicate), or a type has
  // several documents so "the latest" is a decision. Null means none applies.
  //
  // This SELECTS A WARNING. It no longer decides whether anything opens — the
  // wizard always opens, because it is where the build is configured and a project
  // that raised no warning used to get no way in. Keeping the two jobs separate is
  // the point: the warning may follow live data, the wizard's visibility may not.
  const hasChoice = prdOptions.length > 1 || prfaqOptions.length > 1
  const warningKey = warningKeyFor(hasPrd, hasPrfaq, hasExistingPrototype, hasChoice)

  // Only the *start* call is reported here.
  const runBuild = useCallback(async () => {
    // Not reachable through the card, which is disabled on the same condition —
    // but a build with no PRD and no PR-FAQ has no source, so refuse rather than
    // queue a job that can only fail. Verified load-bearing: with the card's
    // disabled state removed, this is the only thing that still stops a billable
    // build with nothing to build from.
    if (!hasPrd && !hasPrfaq) return

    setBusy(true)
    setError(null)
    started.clear()
    try {
      // After the await, never before: a request that throws has not started
      // anything, and an acknowledgement raised early would outlive the failure.
      //
      // The ids are always sent, not only when the user picked one. They name the
      // documents this card was SHOWING, which removes a whole class of
      // disagreement: without them the backend re-resolves "the newest" at build
      // time, so a document saved between render and click would be used instead
      // of the one just confirmed. Blank means the project has none of that type,
      // and the API reads blank as "not aimed".
      await projectsApi.buildPrototype(projectId, {
        response_language: i18n.language,
        source_prd_id: prdId,
        source_prfaq_id: prfaqId,
        // The optional inputs, as the card is showing them. Both false and an
        // empty list is the request this hook sent before they existed.
        use_product_context: useProductContext,
        use_research: useResearch,
        // Never sent while the box is unticked: ids left behind by a box the user
        // turned off are not a selection.
        selected_research_ids: useResearch ? [...selectedResearchIds] : [],
        // Visuals have no gating flag to check first, which is the whole shape
        // difference from the line above: the list IS the request, so it is sent
        // as it stands. Empty is the request this hook made before visuals
        // existed — the backend reads [] as "no visuals selected".
        selected_product_doc_ids: [...selectedVisualIds],
      })
      started.set()
      onJobStarted?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Prototype failed')
    } finally {
      setBusy(false)
    }
  }, [projectId, hasPrd, hasPrfaq, prdId, prfaqId, useProductContext, useResearch,
      selectedResearchIds, selectedVisualIds, i18n.language, onJobStarted, started])

  // Opening is now the card's whole job: no build starts from the card, so this
  // never spends money.
  const onClick = useCallback(() => setIsOpen(true), [])

  const onConfirm = useCallback(() => {
    setIsOpen(false)
    void runBuild()
  }, [runBuild])

  const onCancel = useCallback(() => setIsOpen(false), [])

  return {
    onClick,
    busy,
    error,
    started: started.isSet,
    wizard: {
      // 🔑 A PLAIN BOOLEAN, deliberately, and this is the one place where copying
      // the old `openKey` comparison would be a bug rather than a safeguard.
      //
      // That comparison existed to close a dialog whose *reason* had gone stale —
      // correct for something that only asked a question, because the question was
      // the whole content. This panel holds the user's SELECTIONS, and `warningKey`
      // is derived from documents that refetch whenever a job completes. Closing on
      // a reason change would therefore discard ticked research and visuals
      // mid-interaction, in response to something the user did not do.
      //
      // So visibility is owned here and changes only on an explicit onClick,
      // onConfirm or onCancel. The WARNING still follows live data, which is what
      // #294/#296 actually required: the text may never contradict the documents.
      isOpen,
      warning: warningKey == null ? '' : t(warningKey),
      onConfirm,
      onCancel,
    },
    sources: {
      prdOptions,
      prfaqOptions,
      prdId,
      prfaqId,
      onSelectPrd: setChosenPrdId,
      onSelectPrfaq: setChosenPrfaqId,
    },
    extras: {
      useProductContext,
      onToggleProductContext: setUseProductContext,
      useResearch,
      onToggleResearch,
      researchOptions,
      selectedResearchIds,
      onToggleResearchId,
      researchLimitReached: selectedResearchIds.length >= MAX_SELECTED_RESEARCH_IDS,
      maxResearchIds: MAX_SELECTED_RESEARCH_IDS,
      visualOptions,
      selectedVisualIds,
      onToggleVisualId,
      visualLimitReached: selectedVisualIds.length >= MAX_SELECTED_PRODUCT_DOC_IDS,
      maxVisualIds: MAX_SELECTED_PRODUCT_DOC_IDS,
      visualsExtracting,
      visualsFailed,
    },
  }
}

/**
 * True while `id` still names one of the reports/visuals on offer.
 *
 * Two named predicates rather than the `.some()` written inline at each of the
 * four places that asks: the two option lists are keyed differently
 * (`document_id` vs `doc_id`), so inlining it is the same question spelled four
 * ways — and at the toggle call sites the inline form nests five functions deep,
 * which `sonarjs/no-nested-functions` rejects.
 */
function isOfferedResearch(
  options: ReadonlyArray<PrototypeSourceOption>,
  id: string,
): boolean {
  return options.some((option) => option.document_id === id)
}

function isOfferedVisual(
  options: ReadonlyArray<PrototypeVisualOption>,
  id: string,
): boolean {
  return options.some((option) => option.doc_id === id)
}

/**
 * Add or remove an id in a bounded selection, counting ONLY ids still on offer.
 *
 * Counting the filtered list fixes a real defect rather than tidying: both
 * `researchLimitReached` and `visualLimitReached` are derived from the FILTERED
 * selection, while this guard used to count the raw stored list. Tick four visuals,
 * have one deleted from the Product tab, and the two disagreed — the flag said
 * three so the remaining boxes rendered enabled, and every click on them was
 * silently swallowed by a guard counting four. A control that looks available and
 * does nothing is worse than a disabled one.
 *
 * ⚠️ It follows that the STORED list can exceed the bound: an id that leaves the
 * options stops being counted while it stays in state, and can come back. That is
 * why the two `useMemo`s above SLICE as well as filter — the invariant is enforced
 * where it matters, at the request, rather than depending on every path into state.
 *
 * Shared by both toggles rather than written twice: they had the same bug because
 * they were the same code, and one guard means a fix cannot land on one and miss
 * the other.
 *
 * Removal is never bounded — dropping an id always works, even from an over-long
 * list, which is what keeps a selection recoverable if the bound is ever lowered.
 */
function toggleWithinBound(
  current: ReadonlyArray<string>,
  id: string,
  isStillOnOffer: (id: string) => boolean,
  max: number,
): ReadonlyArray<string> {
  if (current.includes(id)) return current.filter((existing) => existing !== id)
  // Refuse at the bound rather than send a list the API rejects: a 400 arrives
  // after the user has already chosen, and says nothing about what to give up.
  if (current.filter(isStillOnOffer).length >= max) return current
  return [...current, id]
}

/**
 * The id to build from: the user's choice while it is still on offer, else the
 * newest of the type, else '' when the project has none.
 *
 * Falling back rather than trusting the stored choice is what keeps a stale
 * selection from outliving its document. The list refetches whenever a job
 * completes, so a chosen document can be deleted, or a newer one can arrive, under
 * an open card.
 */
function effectiveSourceId(
  options: ReadonlyArray<PrototypeSourceOption>,
  chosenId: string,
): string {
  if (chosenId !== '' && options.some((option) => option.document_id === chosenId)) return chosenId
  return options[0]?.document_id ?? ''
}
