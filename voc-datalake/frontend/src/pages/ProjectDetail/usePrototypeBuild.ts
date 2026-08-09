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
import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { projectsApi } from '../../api/projectsApi'
import { useTransientFlag } from './useTransientFlag'

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
type ConfirmKey = (typeof CONFIRM_MESSAGE)[keyof typeof CONFIRM_MESSAGE]

function confirmKeyFor(
  hasPrd: boolean,
  hasPrfaq: boolean,
  hasExistingPrototype: boolean,
): ConfirmKey | null {
  if (hasExistingPrototype) return CONFIRM_MESSAGE.rebuild
  if (hasOnlyOneDoc(hasPrd, hasPrfaq)) return CONFIRM_MESSAGE[hasPrd ? 'prd' : 'prfaq']
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
const CONFIRM_MESSAGE = {
  prd: 'documents.prototype.confirmPrdOnly',
  prfaq: 'documents.prototype.confirmPrfaqOnly',
  // A prototype already exists. This is the one that costs money to get wrong: the
  // build endpoint has no existing-prototype check, so a second click starts
  // another multi-minute billable build and keeps the first.
  rebuild: 'documents.prototype.confirmRebuild',
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
   * State for the confirm dialog. Open only while the reason it was opened for is
   * still the reason that applies, so `message` is empty exactly when `isOpen` is
   * false rather than needing its own check at the call site.
   */
  readonly confirm: {
    readonly isOpen: boolean
    readonly message: string
    readonly onConfirm: () => void
    readonly onCancel: () => void
  }
}

export function usePrototypeBuild({
  projectId, hasPrd, hasPrfaq, hasExistingPrototype, onJobStarted,
}: {
  readonly projectId: string
  readonly hasPrd: boolean
  readonly hasPrfaq: boolean
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
  const [busy, setBusy] = useState(false)
  // Lowers itself: the panel takes over, so the line must not outlive the gap.
  const started = useTransientFlag()
  const [error, setError] = useState<string | null>(null)
  // The question that was asked, not a bare "a dialog is open" flag — see `openKey`.
  const [askedKey, setAskedKey] = useState<ConfirmKey | null>(null)

  // Two reasons to stop and ask, through the ConfirmModal pattern every other
  // guarded action uses (this began as a window.confirm, which cannot be styled):
  // only one of PRD/PR-FAQ exists, or a prototype already does. Null means neither
  // applies and the build starts on the first click, as it always has.
  const confirmKey = confirmKeyFor(hasPrd, hasPrfaq, hasExistingPrototype)

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
      await projectsApi.buildPrototype(projectId, { response_language: i18n.language })
      started.set()
      onJobStarted?.()
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Prototype failed')
    } finally {
      setBusy(false)
    }
  }, [projectId, hasPrd, hasPrfaq, i18n.language, onJobStarted, started])

  const onClick = useCallback(() => {
    if (confirmKey != null) {
      setAskedKey(confirmKey)
      return
    }
    void runBuild()
  }, [confirmKey, runBuild])

  const onConfirm = useCallback(() => {
    setAskedKey(null)
    void runBuild()
  }, [runBuild])

  const onCancel = useCallback(() => setAskedKey(null), [])

  // The question actually on screen: the one the click raised, and only while it is
  // still the one that applies. `confirmKey` is derived from live data — this page
  // refetches documents whenever a job completes — so a PR-FAQ generation finishing
  // can remove the reason to ask, or replace it with the costlier rebuild one.
  //
  // Comparing keys covers both, where a boolean covered neither: it cannot leave a
  // titled modal up with an empty message, it cannot rewrite the text under the
  // cursor so that "Build anyway" answers a question that was never displayed, and
  // it cannot re-open on a reason the user never saw, because a flag that outlived
  // its question stayed set. A reason that comes back comes back as the same
  // question, which is the one still unanswered.
  const openKey = askedKey != null && askedKey === confirmKey ? askedKey : null

  return {
    onClick,
    busy,
    error,
    started: started.isSet,
    confirm: {
      // One derivation feeding both, for the same reason `confirmKeyFor` is one
      // function: two readings of this state could disagree, and the disagreement
      // looks like a dialog with no question in it.
      isOpen: openKey != null,
      message: openKey == null ? '' : t(openKey),
      onConfirm,
      onCancel,
    },
  }
}
