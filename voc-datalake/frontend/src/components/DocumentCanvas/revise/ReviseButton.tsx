/**
 * @fileoverview "Revise from comments" in the comments rail's header, beside "Ask personas to review": enabled once a
 * thread is answered (resolved, or replied to) and not yet addressed, and while no accepted change of an earlier pass
 * waits for its save (a new pass would lose their marking), with the reason shown otherwise; the pass's running state
 * and its failure said to a screen reader.
 *
 * @module components/DocumentCanvas/revise/ReviseButton
 */
import { Loader2, WandSparkles } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { RevisePass } from './useRevisePass'

interface ReviseButtonProps {
  readonly pass: RevisePass
  /** How many threads a pass would take (reviseChanges.threadsToConsider). */
  readonly available: number
  /** Accepted changes are in the draft, not saved yet (useRevisePass's `holdsAccepted`): Save or Discard first. */
  readonly unsaved?: boolean
  readonly onStart: () => void
}

/** Why a pass cannot start (the first that applies), or null: no thread to take; accepted changes wait for their save. */
function disabledReason(available: number, unsaved: boolean): 'canvas.revise.noThreads' | 'canvas.revise.saveFirst' | null {
  if (available === 0) return 'canvas.revise.noThreads'
  return unsaved ? 'canvas.revise.saveFirst' : null
}

export default function ReviseButton({ pass, available, unsaved = false, onStart }: ReviseButtonProps) {
  const { t } = useTranslation('projectDetail')
  const hintId = useId()
  const running = pass.kind === 'running'
  const reasonKey = disabledReason(available, unsaved)
  const reason = reasonKey === null ? null : t(reasonKey)
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button type="button" className="btn btn-secondary btn-sm" disabled={reason !== null || running} title={t('canvas.revise.hint')}
        aria-describedby={reason === null ? undefined : hintId} onClick={onStart}>
        {running ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <WandSparkles size={14} aria-hidden />}
        {running ? t('canvas.revise.running') : t('canvas.revise.button')}
      </button>
      {reason === null ? null : <span id={hintId} className="text-xs text-muted">{reason}</span>}
      <span role="status" className="sr-only">{running ? t('canvas.revise.running') : ''}</span>
      {pass.kind === 'failed' ? (
        <span role="alert" className="text-xs text-danger">{pass.message ?? t('canvas.revise.failed')}</span>
      ) : null}
    </span>
  )
}
