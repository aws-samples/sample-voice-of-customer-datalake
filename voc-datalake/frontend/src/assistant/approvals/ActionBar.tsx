/**
 * @fileoverview The approval card's buttons: Approve / Decline (with the
 * decline-reason form), the in-flight spinner, and Dismiss for an expired card.
 *
 * @module assistant/approvals/ActionBar
 */
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
}

export function ActionBar(props: Readonly<ActionBarProps>) {
  const { t } = useTranslation('assistantTools')
  const { phase, expired, canApprove, destructive, disabled } = props
  if (phase === 'declining') {
    return <DeclineForm onConfirm={(reason) => props.onDecline(reason)} onCancel={props.onCancelDecline} disabled={disabled} />
  }
  if (expired && phase === 'pending') {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => props.onDecline(EXPIRED_REASON)}
          className="btn btn-secondary btn-sm"
        >
          {t('card.dismiss')}
        </button>
      </div>
    )
  }
  const busy = phase === 'executing'
  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {busy && (
        <span role="status" className="mr-auto inline-flex items-center gap-1 text-[12px] text-muted">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" aria-hidden="true" />
          {t('card.executing')}
        </span>
      )}
      <button
        type="button"
        onClick={props.onStartDecline}
        disabled={busy || disabled}
        className="btn btn-secondary btn-sm"
      >
        {t('card.decline')}
      </button>
      <button
        type="button"
        onClick={props.onApprove}
        disabled={!canApprove}
        className={clsx('btn btn-sm', destructive ? 'btn-danger-solid' : 'btn-primary')}
      >
        {destructive ? t('card.approveDestructive') : t('card.approve')}
      </button>
    </div>
  )
}
