/**
 * @fileoverview Needs review (curators): proposed company memories and
 * conflicts.
 *
 * A conflict renders side by side — the new claim against what it contradicts —
 * with how many people support each, which company objectives it lines up with,
 * and the server's suggested resolution (pre-selected, never auto-applied).
 * Actions map 1:1 onto `POST /memory/review/{id}/resolve`:
 * keep both · keep (this one wins) · replace (the other wins) · merge (new text).
 *
 * @module pages/Memory/MemoryReview
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { AlertCircle, Check, Lightbulb, Loader2, Target } from 'lucide-react'
import { MAX_STATEMENT_CHARS, memoryApi, memoryKeys, RESOLVE_ACTIONS, resolveRequest } from '../../api/memoryApi'
import type { MemoryItem, ResolveAction, ResolveRequest, ReviewEntry } from '../../api/memoryApi'
import { MemoryBadges } from './MemoryCard'

const isUsableStatement = (s: string) => s.trim() !== '' && s.length <= MAX_STATEMENT_CHARS

export default function MemoryReview() {
  const { t } = useTranslation('memory')
  const review = useQuery({ queryKey: memoryKeys.review(), queryFn: memoryApi.review, retry: false })

  if (review.isError) return <p role="alert" className="text-sm text-danger flex items-center gap-2"><AlertCircle size={16} /> {t('loadFailed')}</p>
  if (review.isLoading) return <p className="text-sm text-muted flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> {t('loading')}</p>
  const entries = review.data ?? []
  if (entries.length === 0) return <p className="card text-sm text-muted text-center">{t('review.empty')}</p>
  return (
    <ul className="space-y-4">
      {entries.map((entry) => <ReviewCard key={entry.memory.memory_id} entry={entry} />)}
    </ul>
  )
}

function Side({ memory, label, winner }: Readonly<{ memory: MemoryItem; label: string; winner: boolean }>) {
  return (
    <div className={clsx('rounded-md border p-3 space-y-2 flex-1 min-w-0', winner ? 'border-accent bg-accent-subtle' : 'border-border bg-bg-accent')}>
      <p className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong">{label}</p>
      <p className="text-sm text-text-strong">{memory.statement}</p>
      <MemoryBadges memory={memory} />
    </div>
  )
}

function ReviewCard({ entry }: Readonly<{ entry: ReviewEntry }>) {
  const { t } = useTranslation('memory')
  const queryClient = useQueryClient()
  const { memory, conflicts, suggested_resolution: suggestion } = entry
  const other = conflicts.at(0)
  const [action, setAction] = useState<ResolveAction>(suggestion?.action ?? (other ? 'keep_both' : 'keep'))
  const [statement, setStatement] = useState(suggestion?.statement ?? memory.statement)
  const resolve = useMutation({
    mutationFn: (request: ResolveRequest) => memoryApi.resolve(memory.memory_id, request),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: memoryKeys.all() }),
  })
  // Without a counterpart only keep (publish) and merge (reword) make sense.
  const actions = other ? RESOLVE_ACTIONS : RESOLVE_ACTIONS.filter((a) => a === 'keep' || a === 'merge')
  const submit = () => resolve.mutate(resolveRequest(action, memory, other, statement))
  const blocked = resolve.isPending || (action === 'merge' && !isUsableStatement(statement))

  return (
    <li className="card space-y-3">
      <div className="flex flex-col md:flex-row gap-3">
        <Side memory={memory} label={t(other ? 'review.newClaim' : 'review.proposed')} winner={action === 'keep'} />
        {other ? <Side memory={other} label={t('review.existing')} winner={action === 'replace'} /> : null}
      </div>
      <ReviewHints entry={entry} />
      <div className="tabs-track flex-wrap" role="radiogroup" aria-label={t('review.resolution')}>
        {actions.map((a) => (
          <button key={a} type="button" role="radio" aria-checked={action === a} onClick={() => setAction(a)} className={clsx('tab', action === a && 'tab-active')}>
            {t(`review.actions.${a}`)}
          </button>
        ))}
      </div>
      {action === 'merge' ? (
        <textarea aria-label={t('merge.statement')} value={statement} rows={2} onChange={(e) => setStatement(e.target.value)} className="input" />
      ) : null}
      <ApplyRow pending={resolve.isPending} failed={resolve.isError} blocked={blocked} onApply={submit} />
    </li>
  )
}

/** Which objectives the claim lines up with, and the server's suggestion. */
function ReviewHints({ entry }: Readonly<{ entry: ReviewEntry }>) {
  const { t } = useTranslation('memory')
  const { aligned_objectives: aligned, suggested_resolution: suggestion } = entry
  const reason = suggestion?.reason ? ` — ${suggestion.reason}` : ''
  return (
    <>
      {aligned.length > 0 ? (
        <p className="text-xs text-text flex items-center gap-1.5"><Target size={12} className="text-accent" /> {t('review.aligned', { objectives: aligned.join(', ') })}</p>
      ) : null}
      {suggestion ? (
        <p className="text-xs text-aim bg-aim-subtle rounded-md p-2 flex items-start gap-1.5">
          <Lightbulb size={12} className="mt-0.5 flex-shrink-0" />
          <span>{t('review.suggested', { action: t(`review.actions.${suggestion.action}`) })}{reason}</span>
        </p>
      ) : null}
    </>
  )
}

function ApplyRow({ pending, failed, blocked, onApply }: Readonly<{ pending: boolean; failed: boolean; blocked: boolean; onApply: () => void }>) {
  const { t } = useTranslation('memory')
  return (
    <div className="flex items-center justify-end gap-2">
      {failed ? <span role="alert" className="text-xs text-danger mr-auto">{t('review.failed')}</span> : null}
      <button type="button" onClick={onApply} disabled={blocked} className="btn btn-primary btn-sm flex items-center gap-1.5">
        {pending ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} {t('review.apply')}
      </button>
    </div>
  )
}
