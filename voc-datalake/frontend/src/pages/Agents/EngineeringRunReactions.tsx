/**
 * @fileoverview The run monitor's people's reactions on the host to the run's pull request (7.10.00,
 * `api/engineeringReactionsApi.ts`): the latest read (when and who asked), the pull request's state (merged when,
 * reverted by which commit), the reviews' counts and each reviewer's latest state, the edits after the merge, what the
 * trust filter left out, and each kept reaction with its body as plain text (never HTML). An administrator asks for a
 * new read of an ended run behind a confirmation (at most once an hour per run).
 *
 * @module pages/Agents/EngineeringRunReactions
 */
import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { apiErrorStatus } from '../../api/apiErrorStatus'
import { ENDED_RUN_STATES, askReactions } from '../../api/engineeringReactionsApi'
import { engineeringRunsKeys } from '../../api/engineeringRunsApi'
import { serverReason } from '../../lib/errors'
import { formatDateTime } from '../../utils/dateUtils'
import type { ReactionItem, RunReactions } from '../../api/engineeringReactionsApi'

const KINDS = new Set(['review', 'review_comment', 'comment'])
const REVIEW_STATES = new Set(['approved', 'changes_requested', 'commented'])
const PR_STATES = new Set(['open', 'closed', 'merged'])

function useWhen(): (iso: string) => string {
  const { i18n } = useTranslation('agents')
  return (iso) => formatDateTime(iso, i18n.language, '—')
}

/** Who asked for the read: the run's end, the schedule or a person. */
function useAskedBy(): (by: string) => string {
  const { t } = useTranslation('agents')
  return (by) => {
    if (by === 'run_end' || by === 'schedule') return t(`engineeringRun.reactions.by.${by}`)
    return t('engineeringRun.reactions.by.person')
  }
}

function stateWord(t: (key: string) => string, state: string): string {
  return REVIEW_STATES.has(state) ? t(`engineeringRun.reactions.reviewState.${state}`) : state
}

function Item({ item }: Readonly<{ item: ReactionItem }>) {
  const { t } = useTranslation('agents')
  const when = useWhen()
  const kind = KINDS.has(item.kind) ? t(`engineeringRun.reactions.kind.${item.kind}`) : item.kind
  return (
    <li className="space-y-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <p className="text-[13px] text-muted break-words">
        {t('engineeringRun.reactions.itemLine', { kind, author: item.author, when: when(item.at) })}
        {item.state !== '' && <span className="badge badge-muted ml-2">{stateWord(t, item.state)}</span>}
      </p>
      {item.body !== '' && <p className="whitespace-pre-wrap break-words text-sm text-text-strong">{item.body}</p>}
    </li>
  )
}

function Facts({ reactions }: Readonly<{ reactions: RunReactions }>) {
  const { t } = useTranslation('agents')
  const when = useWhen()
  const askedBy = useAskedBy()
  const { counts, dropped, edits_after_merge: edits } = reactions
  const state = PR_STATES.has(reactions.state) ? t(`engineeringRun.reactions.state.${reactions.state}`) : reactions.state
  return (
    <div className="space-y-1 text-sm">
      <p className="text-[13px] text-muted">
        {t('engineeringRun.reactions.readAt', { when: when(reactions.read_at), by: askedBy(reactions.asked_by) })}
      </p>
      <p>
        <span className="badge badge-muted mr-2">{state}</span>
        {reactions.merged_at !== '' && t('engineeringRun.reactions.merged', { when: when(reactions.merged_at) })}
      </p>
      {reactions.reverted && (
        <p className="text-danger break-all">{t('engineeringRun.reactions.reverted', { commit: reactions.revert_commit })}</p>
      )}
      <p>{t('engineeringRun.reactions.counts', {
        approved: counts.approved, changes: counts.changes_requested, commented: counts.commented,
        reviewComments: counts.review_comments, comments: counts.comments })}</p>
      <p className="break-words">{edits.people_commits > 0
        ? t('engineeringRun.reactions.edits', { count: edits.people_commits, files: edits.files.join(', ') })
        : t('engineeringRun.reactions.noEdits')}</p>
      <p className="text-[13px] text-muted">
        {t('engineeringRun.reactions.dropped', { outsiders: dropped.outsiders, bots: dropped.bots })}
      </p>
      {reactions.more && <p className="text-[13px] text-muted">{t('engineeringRun.reactions.more')}</p>}
    </div>
  )
}

function Reviewers({ reactions }: Readonly<{ reactions: RunReactions }>) {
  const { t } = useTranslation('agents')
  if (reactions.reviewers.length === 0) return null
  return (
    <ul className="flex flex-wrap gap-2 text-sm" aria-label={t('engineeringRun.reactions.reviewers')}>
      {reactions.reviewers.map((reviewer) => (
        <li key={reviewer.reviewer} className="badge badge-muted break-all">
          {reviewer.reviewer}: {stateWord(t, reviewer.state)}
        </li>
      ))}
    </ul>
  )
}

/** The hand trigger: on an ended run only, behind a confirmation; the overview is read again once it is asked. */
function AskReactions({ runId, status }: Readonly<{ runId: string; status: string }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const ended = ENDED_RUN_STATES.includes(status)
  const ask = useMutation({
    mutationFn: () => askReactions(runId),
    onSettled: () => { setConfirming(false) },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: engineeringRunsKeys.overview(runId) }),
  })
  const failure = (): string => {
    if (apiErrorStatus(ask.error) === 429) return t('engineeringRun.reactions.ask.tooSoon')
    return t('engineeringRun.reactions.ask.failed', { reason: serverReason(ask.error) ?? t('engineeringRun.reactions.ask.retry') })
  }
  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-secondary" disabled={!ended || ask.isPending}
        aria-describedby={ended ? undefined : 'engineering-reactions-not-ended'} onClick={() => { setConfirming(true) }}>
        {t('engineeringRun.reactions.ask.button')}
      </button>
      {!ended && <p id="engineering-reactions-not-ended" className="text-[13px] text-muted">{t('engineeringRun.reactions.ask.notEnded')}</p>}
      <p role="status" className="text-[13px]">
        {ask.isSuccess && t('engineeringRun.reactions.ask.asked')}
        {ask.isError && failure()}
      </p>
      {confirming && (
        <ConfirmModal isOpen title={t('engineeringRun.reactions.ask.confirmTitle')}
          message={t('engineeringRun.reactions.ask.confirmMessage')} confirmLabel={t('engineeringRun.reactions.ask.confirm')}
          cancelLabel={t('common.cancel')} variant="info" isLoading={ask.isPending}
          onConfirm={() => { ask.mutate() }} onCancel={() => { setConfirming(false) }} />
      )}
    </div>
  )
}

export function EngineeringRunReactions({ runId, status, reactions, isAdmin }: Readonly<{
  runId: string; status: string; reactions: RunReactions | null; isAdmin: boolean
}>) {
  const { t } = useTranslation('agents')
  return (
    <section className="card space-y-3 min-w-0" aria-labelledby="engineering-run-reactions">
      <h2 id="engineering-run-reactions" className="text-sm font-medium text-text-strong">{t('engineeringRun.reactions.title')}</h2>
      {reactions === null ? <p className="text-sm text-muted">{t('engineeringRun.reactions.none')}</p> : (
        <>
          <Facts reactions={reactions} />
          <Reviewers reactions={reactions} />
          {reactions.items.length > 0 && (
            <ul className="space-y-2" aria-label={t('engineeringRun.reactions.items')}>
              {reactions.items.map((item) => <Item key={`${item.at}-${item.kind}-${item.author}`} item={item} />)}
            </ul>
          )}
        </>
      )}
      {isAdmin && <AskReactions runId={runId} status={status} />}
    </section>
  )
}
