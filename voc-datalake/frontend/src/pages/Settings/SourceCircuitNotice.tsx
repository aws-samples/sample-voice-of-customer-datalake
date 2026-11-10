/**
 * @fileoverview "Paused after repeated failures" notice on a Settings source card.
 * @module pages/Settings/SourceCircuitNotice
 *
 * Shown while the plugin's circuit breaker is tripped (plugins/_shared/circuit_breaker.py):
 * every run is skipped and the schedule was turned off. Turning the source back on
 * resets it; an admin can also reset it without turning the schedule on.
 */
import { useTranslation } from 'react-i18next'
import { AlertTriangle, Loader2, RotateCcw } from 'lucide-react'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { formatTimestamp } from './logsFormat'
import type { SourceCircuit } from '../../api/sourcesStatusSchema'

/** A one-line reason: the stored error is bounded at 500 characters, the card shows less. */
const MAX_REASON_CHARS = 160

function shortReason(error: string): string {
  const firstLine = (error.split('\n', 1)[0] ?? '').trim()
  return firstLine.length > MAX_REASON_CHARS ? `${firstLine.slice(0, MAX_REASON_CHARS - 1)}…` : firstLine
}

interface Props {
  readonly circuit: SourceCircuit
  readonly isAdmin: boolean
  readonly resetting: boolean
  readonly resetFailed: boolean
  readonly onReset: () => void
}

export default function SourceCircuitNotice({ circuit, isAdmin, resetting, resetFailed, onReset }: Props) {
  const { t, i18n } = useTranslation('settings')
  if (!circuit.tripped) return null

  const reason = circuit.last_error === null || circuit.last_error === '' ? null : shortReason(circuit.last_error)
  return (
    <div role="status" className="mx-3 sm:mx-4 mb-3 rounded-md border border-warn bg-warn-subtle p-3 text-sm">
      <div className="flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-3">
        <AlertTriangle size={16} aria-hidden="true" className="text-warn flex-shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1 space-y-1">
          <p className="font-medium text-text-strong">{t('sourceCard.circuit.paused')}</p>
          <p className="text-text">
            {circuit.tripped_at === null ? null : (
              <span>{t('sourceCard.circuit.since', { time: formatTimestamp(circuit.tripped_at, t, i18n.language) })} · </span>
            )}
            <span>{t('sourceCard.circuit.failures', { n: circuit.failure_count })}</span>
          </p>
          {reason === null ? null : (
            <p className="text-muted break-words" title={circuit.last_error ?? undefined}>
              {t('sourceCard.circuit.reason', { reason })}
            </p>
          )}
          <p className="text-muted">{t('sourceCard.circuit.enableResets')}</p>
          {resetFailed && <p className="text-warn" role="alert">{t('sourceCard.circuit.resetFailed')}</p>}
        </div>
        <button
          type="button"
          onClick={onReset}
          disabled={!isAdmin || resetting}
          title={isAdmin ? t('sourceCard.circuit.resetHint') : ADMIN_ONLY_TITLE}
          className="btn btn-secondary btn-sm flex items-center gap-1.5 self-start disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {resetting
            ? <Loader2 size={14} className="animate-spin" aria-hidden="true" />
            : <RotateCcw size={14} aria-hidden="true" />}
          {resetting ? t('sourceCard.circuit.resetting') : t('sourceCard.circuit.reset')}
        </button>
      </div>
    </div>
  )
}
