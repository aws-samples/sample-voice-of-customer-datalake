/**
 * @fileoverview The changes a "Revise from comments" pass proposes, reviewed above the canvas: a list of groups, one
 * per change, each with the passage struck (removed) and its replacement (added) — said in words to a screen reader,
 * never by colour alone —, why, the threads it answers, and its own Accept / Reject; Accept all / Reject all for the
 * rest. A change whose passage the draft no longer holds exactly once is "out of date" and cannot be accepted.
 *
 * Accepting puts the change into the draft (the page is then dirty); Save makes the version, and its threads are then
 * marked addressed by it (useRevisePass).
 *
 * @module components/DocumentCanvas/revise/ProposalReview
 */
import clsx from 'clsx'
import { Check, X } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import RecommendationList from './RecommendationList'
import RevisePanelShell from './RevisePanelShell'
import ThreadLink from './ThreadLink'
import { isOutOfDate } from './reviseChanges'
import type { Decision, RevisePass, RevisePassControls } from './useRevisePass'
import type { CommentThread, ReviseChange } from '../../../api/documentReviewSchema'

type Proposal = Extract<RevisePass, { kind: 'proposal' }>

/** A change as the review shows it: decided, or pending and still (or no longer) in the draft. */
type ChangeState = Decision | 'pending' | 'outOfDate'

const BADGES: Readonly<Record<Exclude<ChangeState, 'pending'>, string>> = {
  accepted: 'badge-ok', addressed: 'badge-info', rejected: 'badge-muted', outOfDate: 'badge-warn',
}

function StateBadge({ state }: Readonly<{ state: Exclude<ChangeState, 'pending'> }>) {
  const { t } = useTranslation('projectDetail')
  const labels = {
    accepted: t('canvas.revise.proposal.state.accepted'), addressed: t('canvas.revise.proposal.state.addressed'),
    rejected: t('canvas.revise.proposal.state.rejected'), outOfDate: t('canvas.revise.proposal.state.outOfDate'),
  }
  return <span className={clsx('badge', BADGES[state])}>{labels[state]}</span>
}

function stateOf(pass: Proposal, change: ReviseChange, draft: string): ChangeState {
  const decision = pass.decisions[change.change_id]
  if (decision !== undefined) return decision
  return isOutOfDate(draft, change) ? 'outOfDate' : 'pending'
}

function ChangeGroup({ change, n, state, threads, onShowThread, onAccept, onReject }: Readonly<{
  change: ReviseChange; n: number; state: ChangeState; threads: ReadonlyMap<string, CommentThread>
  onShowThread: (threadId: string) => void; onAccept: () => void; onReject: () => void
}>) {
  const { t } = useTranslation('projectDetail')
  const labelId = useId()
  return (
    <div role="group" aria-labelledby={labelId} data-change-state={state}
      className={clsx('rounded-md border bg-card p-2 space-y-2 min-w-0', state === 'pending' ? 'border-border' : 'border-dashed border-border')}>
      <div className="flex flex-wrap items-center gap-2">
        <span id={labelId} className="mr-auto text-xs font-semibold text-text">{t('canvas.revise.proposal.change', { position: n })}</span>
        {state === 'pending' ? null : <StateBadge state={state} />}
      </div>
      <div className="space-y-1 text-[13px]">
        <p className="rounded-md border-l-4 border-danger bg-danger-subtle px-2 py-1 whitespace-pre-wrap break-words">
          <span className="sr-only">{t('canvas.revise.proposal.removed')}: </span>
          <del className="text-muted decoration-danger/50">{change.before}</del>
        </p>
        <p className="rounded-md border-l-4 border-ok bg-ok-subtle px-2 py-1 whitespace-pre-wrap break-words">
          <span className="sr-only">{t('canvas.revise.proposal.added')}: </span>
          {change.after === '' ? <em className="text-muted">{t('canvas.revise.proposal.deleted')}</em> : <ins className="no-underline text-text">{change.after}</ins>}
        </p>
      </div>
      {change.reason === '' ? null : <p className="text-xs text-muted break-words">{change.reason}</p>}
      <div className="flex flex-wrap items-center gap-1 min-w-0">
        <span className="text-xs text-muted">{t('canvas.revise.proposal.answers')}</span>
        {change.thread_ids.map((id) => <ThreadLink key={id} threadId={id} threads={threads} onShowThread={onShowThread} />)}
      </div>
      {state === 'pending' || state === 'outOfDate' ? (
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary btn-sm" disabled={state === 'outOfDate'} onClick={onAccept}
            aria-label={t('canvas.revise.proposal.acceptNamed', { position: n })}>
            <Check size={14} aria-hidden />{t('canvas.revise.proposal.accept')}
          </button>
          <button type="button" className="btn btn-secondary btn-sm" onClick={onReject} aria-label={t('canvas.revise.proposal.rejectNamed', { position: n })}>
            <X size={14} aria-hidden />{t('canvas.revise.proposal.reject')}
          </button>
        </div>
      ) : null}
    </div>
  )
}

/** The status line: the last save's marking, else what to do next, else how many were proposed. */
function ProposalStatus({ pass, states }: Readonly<{ pass: Proposal; states: readonly ChangeState[] }>) {
  const { t } = useTranslation('projectDetail')
  if (pass.marked === 'failed') return t('canvas.revise.proposal.markFailed')
  if (pass.marked !== null) return t('canvas.revise.proposal.marked', { count: pass.marked.count, version: pass.marked.version })
  if (states.includes('accepted')) return t('canvas.revise.proposal.saveNote')
  return t('canvas.revise.proposal.status', { count: states.length })
}

interface ProposalReviewProps {
  readonly pass: Proposal
  readonly controls: RevisePassControls
  /** The draft now: which pending changes are out of date. */
  readonly draft: string
  readonly threads: ReadonlyMap<string, CommentThread>
  readonly onShowThread: (threadId: string) => void
}

export default function ProposalReview({ pass, controls, draft, threads, onShowThread }: ProposalReviewProps) {
  const { t } = useTranslation('projectDetail')
  const { changes, dropped, recommendations } = pass.result
  const states = changes.map((change) => stateOf(pass, change, draft))
  const open = states.some((state) => state === 'pending' || state === 'outOfDate')
  const actions = open ? (
    <>
      <button type="button" className="btn btn-primary btn-sm" disabled={!states.includes('pending')} onClick={() => controls.acceptAll()}>
        {t('canvas.revise.proposal.acceptAll')}
      </button>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => controls.rejectAll()}>{t('canvas.revise.proposal.rejectAll')}</button>
    </>
  ) : null
  return (
    <RevisePanelShell testId="revise-proposal" title={t('canvas.revise.proposal.title')} status={<ProposalStatus pass={pass} states={states} />}
      actions={actions} onClose={controls.close}>
      {changes.length === 0 ? (
        <>
          <p className="text-[13px] text-muted">{t('canvas.revise.proposal.none')}</p>
          <RecommendationList recommendations={recommendations} threads={threads} onShowThread={onShowThread} />
        </>
      ) : (
        <>
          <p className="text-xs text-muted">{t('canvas.revise.proposal.intro')}</p>
          <ol aria-label={t('canvas.revise.proposal.listLabel')} className="space-y-2">
            {changes.map((change, index) => (
              <li key={change.change_id}>
                <ChangeGroup change={change} n={index + 1} state={states[index] ?? 'pending'} threads={threads} onShowThread={onShowThread}
                  onAccept={() => controls.accept(change.change_id)} onReject={() => controls.reject(change.change_id)} />
              </li>
            ))}
          </ol>
        </>
      )}
      {dropped > 0 ? <p className="text-xs text-muted">{t('canvas.revise.proposal.dropped', { count: dropped })}</p> : null}
    </RevisePanelShell>
  )
}
