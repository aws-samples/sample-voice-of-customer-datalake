/**
 * @fileoverview The approval card's buttons: Approve / Decline (with the
 * decline-reason form), the in-flight spinner, and Dismiss for an expired card.
 *
 * A plan proposal (`variant: 'plan'`) reads Approve and run / Change / Decline:
 * Change is a decline whose note asks the assistant to revise the plan, which
 * it then proposes again (a revised plan is approved again).
 *
 * @module assistant/approvals/ActionBar
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Loader2 } from 'lucide-react'
import { DeclineForm } from './CardParts'
import { EXPIRED_REASON } from '../thread/resume'

interface ActionBarProps {
  phase: 'pending' | 'declining' | 'executing'
  expired: boolean
  canApprove: boolean
  destructive: boolean
  disabled: boolean
  onApprove: () => void
  onStartDecline: () => void
  onCancelDecline: () => void
  onDecline: (reason?: string) => void
  /** `plan`: the buttons of a plan proposal. */
  variant?: 'tool' | 'plan'
}

/** The declined outcome's reason for a plan's Change: the model revises and proposes again. */
function changeRequestReason(note: string): string {
  const asked = note === '' ? '' : ` The user's note: ${note}`
  return `The user asks to change the plan before approving it.${asked} Revise the plan and propose it again with propose_plan.`
}

function ExpiredBar({ onDecline }: Readonly<{ onDecline: (reason?: string) => void }>) {
  const { t } = useTranslation('assistantTools')
  return (
    <div className="flex justify-end">
      <button type="button" onClick={() => onDecline(EXPIRED_REASON)} className="btn btn-secondary btn-sm">
        {t('card.dismiss')}
      </button>
    </div>
  )
}

function approveLabelKey(variant: 'tool' | 'plan', destructive: boolean): string {
  if (variant === 'plan') return 'card.approvePlan'
  return destructive ? 'card.approveDestructive' : 'card.approve'
}

export function ActionBar(props: Readonly<ActionBarProps>) {
  const { t } = useTranslation('assistantTools')
  const [mode, setMode] = useState<'decline' | 'change'>('decline')
  const { phase, expired, canApprove, destructive, disabled, variant = 'tool' } = props
  if (phase === 'declining') {
    const confirm = (reason: string) => props.onDecline(mode === 'change' ? changeRequestReason(reason) : reason)
    return <DeclineForm mode={mode} onConfirm={confirm} onCancel={props.onCancelDecline} disabled={disabled} />
  }
  if (expired && phase === 'pending') return <ExpiredBar onDecline={props.onDecline} />
  const busy = phase === 'executing'
  const startDecline = (next: 'decline' | 'change') => {
    setMode(next)
    props.onStartDecline()
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {busy && (
        <span role="status" className="mr-auto inline-flex items-center gap-1 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden="true" />
          {t('card.executing')}
        </span>
      )}
      <button type="button" onClick={() => startDecline('decline')} disabled={busy || disabled} className="btn btn-secondary btn-sm">
        {t('card.decline')}
      </button>
      {variant === 'plan' && (
        <button type="button" onClick={() => startDecline('change')} disabled={busy || disabled} className="btn btn-secondary btn-sm">
          {t('card.change')}
        </button>
      )}
      <button
        type="button"
        onClick={props.onApprove}
        disabled={!canApprove}
        className={clsx('btn btn-sm', destructive ? 'btn-danger-solid' : 'btn-primary')}
      >
        {t(approveLabelKey(variant, destructive))}
      </button>
    </div>
  )
}
