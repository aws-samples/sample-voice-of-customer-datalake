/**
 * @fileoverview What a "Revise from comments" pass answered, above the canvas, by its outcome:
 *
 * - recommendations: one per thread, each linked to its thread; nothing written, and why (the way of working);
 * - proposal: the changes to accept or reject (ProposalReview);
 * - applied: "Revised from N comments as vX", with Undo (restores the version the pass read, as a new version; when
 *   a version was saved since, it says so first and offers Undo anyway / Keep it) and Review again (asks the personas
 *   to review the revised version).
 *
 * @module components/DocumentCanvas/revise/RevisePanel
 */
import { Loader2, RotateCcw, UsersRound } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import ProposalReview from './ProposalReview'
import RecommendationList from './RecommendationList'
import RevisePanelShell from './RevisePanelShell'
import { threadIdsOf } from './reviseChanges'
import type { RevisePass, RevisePassControls, UndoState } from './useRevisePass'
import type { CommentThread } from '../../../api/documentReviewSchema'

type Applied = Extract<RevisePass, { kind: 'applied' }>

function useUndoStatus(pass: Applied): string {
  const { t } = useTranslation('projectDetail')
  const statuses: Readonly<Record<UndoState, string>> = {
    idle: t('canvas.revise.applied.status'), running: t('canvas.revise.applied.undoing'),
    confirm: t('canvas.revise.applied.undoNewer', { version: pass.newer ?? 0 }),
    done: t('canvas.revise.applied.undone'), failed: t('canvas.revise.applied.undoFailed'),
  }
  return statuses[pass.undo]
}

/** A version was saved after the revision: Undo anyway (it reverts that change too) or Keep it (focused: the safe one). */
function ConfirmUndo({ controls }: Readonly<{ controls: RevisePassControls }>) {
  const { t } = useTranslation('projectDetail')
  const keep = useRef<HTMLButtonElement>(null)
  useEffect(() => { keep.current?.focus() }, [])
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => void controls.undoAnyway()}>
        <RotateCcw size={14} aria-hidden />{t('canvas.revise.applied.undoAnyway')}
      </button>
      <button ref={keep} type="button" className="btn btn-secondary btn-sm" onClick={controls.keepRevision}>
        {t('canvas.revise.applied.undoKeep')}
      </button>
    </>
  )
}

function AppliedBanner({ pass, controls, onReviewAgain, canReview }: Readonly<{
  pass: Applied; controls: RevisePassControls; onReviewAgain: () => void; canReview: boolean
}>) {
  const { t } = useTranslation('projectDetail')
  const version = pass.result.applied_version?.version ?? 0
  // The comments the revision answers (its changes' threads), whether or not marking them addressed succeeded.
  const title = t('canvas.revise.applied.banner', { count: threadIdsOf(pass.result.changes).length, version })
  const status = useUndoStatus(pass)
  const actions = (
    <>
      {pass.undo === 'confirm' ? <ConfirmUndo controls={controls} /> : null}
      {pass.undo === 'done' || pass.undo === 'confirm' ? null : (
        <button type="button" className="btn btn-secondary btn-sm" disabled={pass.undo === 'running'} onClick={() => void controls.undo()}>
          {pass.undo === 'running' ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden /> : <RotateCcw size={14} aria-hidden />}
          {t('canvas.revise.applied.undo')}
        </button>
      )}
      <button type="button" className="btn btn-secondary btn-sm" disabled={!canReview} onClick={onReviewAgain}>
        <UsersRound size={14} aria-hidden />{t('canvas.revise.applied.reviewAgain')}
      </button>
    </>
  )
  return (
    <RevisePanelShell testId="revise-applied" title={title} actions={actions} onClose={controls.close} status={status} />
  )
}

interface RevisePanelProps {
  readonly controls: RevisePassControls
  /** The draft now (a proposal's out-of-date changes). */
  readonly draft: string
  readonly threads: readonly CommentThread[]
  readonly onShowThread: (threadId: string) => void
  /** Starts "Ask personas to review" (the applied banner's Review again). */
  readonly onReviewAgain: () => void
  readonly canReview: boolean
}

export default function RevisePanel({ controls, draft, threads, onShowThread, onReviewAgain, canReview }: RevisePanelProps) {
  const { t } = useTranslation('projectDetail')
  const byId = useMemo(() => new Map(threads.map((thread) => [thread.comment_id, thread])), [threads])
  const { pass } = controls
  if (pass.kind === 'proposal') {
    return <ProposalReview pass={pass} controls={controls} draft={draft} threads={byId} onShowThread={onShowThread} />
  }
  if (pass.kind === 'applied') return <AppliedBanner pass={pass} controls={controls} onReviewAgain={onReviewAgain} canReview={canReview} />
  if (pass.kind !== 'recommendations') return null
  const { recommendations } = pass.result
  return (
    <RevisePanelShell testId="revise-recommendations" title={t('canvas.revise.recommendations.title')}
      status={t('canvas.revise.recommendations.status', { count: recommendations.length })} onClose={controls.close}>
      <p className="text-xs text-muted">{t('canvas.revise.recommendations.why')}</p>
      <RecommendationList recommendations={recommendations} threads={byId} onShowThread={onShowThread} />
    </RevisePanelShell>
  )
}
