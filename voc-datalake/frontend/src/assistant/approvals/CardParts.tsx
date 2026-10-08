/**
 * @fileoverview Presentational pieces of the approval card: header (title,
 * project chip, expiry), the decline form and the compact resolved state.
 *
 * @module assistant/approvals/CardParts
 */
import { useEffect, useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { CheckCircle2, Clock, FolderKanban, MinusCircle, ShieldAlert, Trash2, XCircle } from 'lucide-react'
import { formatRemaining } from './useExpiry'
import { EXPIRED_REASON } from '../thread/resume'
import { useProjectDetail } from './previews/useProjectDetail'
import type { ToolOutcome } from '../contract'
import type { Expiry } from './useExpiry'

function ProjectChip({ projectId }: Readonly<{ projectId: string }>) {
  const { t } = useTranslation('assistantTools')
  const { data } = useProjectDetail(projectId)
  const name = data?.project.name ?? projectId
  return (
    <span className="badge badge-muted max-w-full">
      <FolderKanban className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('card.project')}: </span>
      <span className="truncate">{name}</span>
    </span>
  )
}

function ExpiryBadge({ expiry }: Readonly<{ expiry: Expiry }>) {
  const { t } = useTranslation('assistantTools')
  if (expiry.remainingMs === null) return null
  // `text-text`, not `text-muted`: the badge sits on the card's warn/danger
  // tinted header, where muted drops below AA in Kiro Dark (4.08:1).
  return (
    <span className={clsx('inline-flex items-center gap-1 font-mono text-[12px]', expiry.expired ? 'text-danger' : 'text-text')}>
      <Clock className="h-3 w-3" aria-hidden="true" />
      {expiry.expired
        ? t('card.expired')
        : t('card.expiresIn', { time: formatRemaining(expiry.remainingMs) })}
    </span>
  )
}

interface CardHeaderProps {
  titleId: string
  title: string
  destructive: boolean
  projectId?: string
  expiry: Expiry
}

export function CardHeader({ titleId, title, destructive, projectId, expiry }: Readonly<CardHeaderProps>) {
  const { t } = useTranslation('assistantTools')
  const Icon = destructive ? Trash2 : ShieldAlert
  return (
    <div className={clsx(
      '-mx-3 -mt-3 flex items-start gap-2 rounded-t-lg border-b px-3 py-2.5',
      destructive ? 'border-danger/30 bg-danger-subtle' : 'border-warn/30 bg-warn-subtle',
    )}
    >
      <Icon className={clsx('h-5 w-5 shrink-0 mt-0.5', destructive ? 'text-danger' : 'text-warn')} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className={clsx('text-[11px] font-semibold uppercase tracking-[.08em]', destructive ? 'text-danger' : 'text-warn')}>
          {destructive ? t('card.kickerDestructive') : t('card.kicker')}
        </p>
        <h3 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong break-words">{title}</h3>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {projectId !== undefined && projectId !== '' && <ProjectChip projectId={projectId} />}
          <ExpiryBadge expiry={expiry} />
        </div>
      </div>
    </div>
  )
}

interface DeclineFormProps {
  onConfirm: (reason: string) => void
  onCancel: () => void
  disabled: boolean
}

export function DeclineForm({ onConfirm, onCancel, disabled }: Readonly<DeclineFormProps>) {
  const { t } = useTranslation('assistantTools')
  const [reason, setReason] = useState('')
  const inputId = useId()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { inputRef.current?.focus() }, [])
  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault()
        onConfirm(reason.trim())
      }}
    >
      <label htmlFor={inputId} className="block text-[12px] font-medium text-muted">{t('card.reasonLabel')}</label>
      <textarea
        id={inputId}
        ref={inputRef}
        value={reason}
        maxLength={500}
        rows={2}
        onChange={(e) => setReason(e.target.value)}
        placeholder={t('card.reasonPlaceholder')}
        className="input resize-none"
      />
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} disabled={disabled} className="btn btn-ghost btn-sm">
          {t('card.back')}
        </button>
        <button type="submit" disabled={disabled} className="btn btn-secondary btn-sm">
          {t('card.confirmDecline')}
        </button>
      </div>
    </form>
  )
}

const RESOLVED_STYLE = {
  executed: { Icon: CheckCircle2, className: 'text-ok bg-ok-subtle border-ok/30' },
  failed: { Icon: XCircle, className: 'text-danger bg-danger-subtle border-danger/30' },
  declined: { Icon: MinusCircle, className: 'text-muted bg-bg-accent border-border' },
} as const

function outcomeDetail(outcome: ToolOutcome): string | undefined {
  if (outcome.status === 'executed') return outcome.summary
  if (outcome.status === 'failed') return outcome.error
  return outcome.reason
}

export function ResolvedState({ title, outcome }: Readonly<{ title: string; outcome: ToolOutcome }>) {
  const { t } = useTranslation('assistantTools')
  const { Icon, className } = RESOLVED_STYLE[outcome.status]
  const expired = outcome.status === 'declined' && outcome.reason === EXPIRED_REASON
  const detail = expired ? undefined : outcomeDetail(outcome)
  return (
    <div className={clsx('flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px] animate-rise', className)}>
      <Icon className="h-4 w-4 shrink-0 mt-0.5" aria-hidden="true" />
      <div className="min-w-0">
        <p>
          <span className="font-medium">{expired ? t('card.resolved.expired') : t(`card.resolved.${outcome.status}`)}</span>
          {' · '}
          <span className="break-words">{title}</span>
        </p>
        {detail !== undefined && detail !== '' && <p className="text-[12px] break-words text-text">{detail}</p>}
      </div>
    </div>
  )
}
