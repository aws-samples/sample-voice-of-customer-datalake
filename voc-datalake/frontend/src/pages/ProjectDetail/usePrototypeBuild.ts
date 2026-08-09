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

// Keyed rather than branched in a helper, so the i18n extractor still sees both
// keys literally — a key assembled at runtime is invisible to it, which is the
// blind spot that has left whole surfaces untranslated here before.
const SINGLE_DOC_MESSAGE = {
  prd: { key: 'documents.prototype.confirmPrdOnly', defaultValue: 'No PR-FAQ yet — the prototype will be built from the PRD only. Continue?' },
  prfaq: { key: 'documents.prototype.confirmPrfaqOnly', defaultValue: 'No PRD yet — the prototype will be built from the PR-FAQ only. Continue?' },
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
  /** State for the confirm dialog the single-source-document case needs. */
  readonly confirm: {
    readonly isOpen: boolean
    readonly message: string
    readonly onConfirm: () => void
    readonly onCancel: () => void
  }
}

export function usePrototypeBuild({
  projectId, hasPrd, hasPrfaq, onJobStarted,
}: {
  readonly projectId: string
  readonly hasPrd: boolean
  readonly hasPrfaq: boolean
  /** Tells the Background Jobs panel to pick the new job up. */
  readonly onJobStarted?: () => void
}): PrototypeBuildControl {
  const { t, i18n } = useTranslation('projectDetail')
  const [busy, setBusy] = useState(false)
  // Lowers itself: the panel takes over, so the line must not outlive the gap.
  const started = useTransientFlag()
  const [error, setError] = useState<string | null>(null)
  const [showConfirm, setShowConfirm] = useState(false)

  // Both → build straight away. Only one → confirm we'll build from just that
  // document. This was a window.confirm, which cannot be styled and sat outside
  // the ConfirmModal pattern every other guarded action in the app uses.
  const needsConfirm = hasOnlyOneDoc(hasPrd, hasPrfaq)
  const single = SINGLE_DOC_MESSAGE[hasPrd ? 'prd' : 'prfaq']

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
    if (needsConfirm) {
      setShowConfirm(true)
      return
    }
    void runBuild()
  }, [needsConfirm, runBuild])

  const onConfirm = useCallback(() => {
    setShowConfirm(false)
    void runBuild()
  }, [runBuild])

  const onCancel = useCallback(() => setShowConfirm(false), [])

  return {
    onClick,
    busy,
    error,
    started: started.isSet,
    confirm: {
      isOpen: showConfirm,
      message: t(single.key, { defaultValue: single.defaultValue }),
      onConfirm,
      onCancel,
    },
  }
}
