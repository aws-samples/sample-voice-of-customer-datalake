/**
 * @fileoverview The run's control bar (7.51.00; the UX audit's S8 and S9), in the workspace's header: the run's
 * status chip, then, for an admin on a run under way, **Pause** or **Resume** (one toggle, by the agents' state),
 * **Stop** (a checkpoint, then the end: the `shutdown` signal) with "Stop now, without saving" in its menu (asked
 * first), and Save a checkpoint under ⋯; on an ended run, **Restart run** (a child run, RestartRunDialog.tsx).
 *
 * Stop is offered to an admin on every run that has not ended, whether or not the deployment connects the runtime
 * (`actions_available`): the API ends a run that has no live session too (7.50.03). Pause, Resume and Save need the
 * runtime, and a line says so where it is not connected. Once Stop is sent the chip reads Stopping… (Stop inert)
 * until the run has ended, and a status line says what each agent did. A read of the run that failed keeps the bar
 * (its last good state), with Retry.
 *
 * @module pages/Agents/RunWorkspace/RunControlBar
 */
import { useState } from 'react'
import { ChevronDown, Loader2, MoreHorizontal, Pause, Play, RotateCcw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { useEngineeringSignal } from '../useEngineeringRun'
import { useActionError } from '../engineeringRunText'
import { ActionsMenu } from './ActionsMenu'
import { RestartRunDialog } from './RestartRunDialog'
import { statusChipClass } from './agentStatus'
import type { EngineeringAgent, EngineeringOverview, SignalSent } from '../../../api/engineeringRunsApi'

/** The agents' statuses that are over (they take no signal), and the ones of a pause. */
const ENDED = new Set(['done', 'failed', 'stopped'])
const PAUSED = new Set(['paused', 'pause_requested'])
const STOPS: ReadonlySet<string> = new Set(['shutdown', 'stop_now'])

/** The run is paused when every agent still at it is paused (or asked to be). */
function runPaused(agents: readonly EngineeringAgent[]): boolean {
  const going = agents.filter((agent) => !ENDED.has(agent.status))
  return going.length > 0 && going.every((agent) => PAUSED.has(agent.status))
}

function StatusChip({ status, stopping, paused }: Readonly<{ status: string; stopping: boolean; paused: boolean }>) {
  const { t } = useTranslation('agents')
  if (status === '') return <span className={statusChipClass('')}>{t('engineeringRun.statusUnknown')}</span>
  if (stopping) {
    return (
      <span className="badge badge-warn inline-flex items-center gap-1">
        <Loader2 size={12} className="animate-spin" aria-hidden="true" /> {t('runWorkspace.controls.stopping')}
      </span>
    )
  }
  if (paused) return <span className={statusChipClass('paused')}>{t('engineeringRun.status.paused')}</span>
  return <span className={statusChipClass(status)}>{t(`runWorkspace.runs.statuses.${status}`, { defaultValue: status })}</span>
}

/** What a signal did: each agent's status after it ("fixer-3: Stopped"), and whether it did anything to it. */
function useSignalLine(): (sent: SignalSent) => string {
  const { t } = useTranslation('agents')
  return (sent) => Object.entries(sent.agents).sort(([a], [b]) => a.localeCompare(b)).map(([agent, status]) => (
    t(sent.applied[agent] === true ? 'engineeringRun.agentStatus' : 'engineeringRun.agentNotApplied',
      { agent, status: t(`engineeringRun.status.${status}`, { defaultValue: status }) })
  )).join(' · ')
}

function LiveControls({ overview, paused, stopping, send, onStopNow }: Readonly<{
  overview: EngineeringOverview; paused: boolean; stopping: boolean; send: (signal: 'pause' | 'resume' | 'shutdown' | 'save') => void
  onStopNow: () => void
}>) {
  const { t } = useTranslation('agents')
  const connected = overview.actions_available
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {connected && (
        <button type="button" className="btn btn-secondary btn-sm" disabled={stopping} onClick={() => send(paused ? 'resume' : 'pause')}>
          {paused ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {t(paused ? 'engineeringRun.signals.resume' : 'engineeringRun.signals.pause')}
        </button>
      )}
      <span className="inline-flex">
        <button type="button" className="btn btn-secondary btn-sm rounded-r-none" aria-disabled={stopping}
          onClick={() => { if (!stopping) send('shutdown') }}>
          <Square size={14} aria-hidden="true" /> {t('engineeringRun.signals.shutdown')}
        </button>
        <ActionsMenu label={t('runWorkspace.controls.moreStop')} face={<ChevronDown size={14} aria-hidden="true" />}
          buttonClassName="btn btn-secondary btn-sm rounded-l-none border-l-0 px-1.5"
          actions={[{ id: 'stop_now', label: t('runWorkspace.controls.stopNow'), danger: true, onSelect: onStopNow }]} />
      </span>
      {connected && (
        <ActionsMenu label={t('runWorkspace.controls.more')} face={<MoreHorizontal size={16} aria-hidden="true" />} buttonClassName="icon-btn"
          actions={[{ id: 'save', label: t('runWorkspace.controls.save'), onSelect: () => send('save') }]} />
      )}
    </div>
  )
}

/** The bar's lines: why some controls are missing, the ended run's way on, a failed read, and what a signal did. */
function BarNotes({ live, isAdmin, connected, refreshFailed, onRetry, error, done }: Readonly<{
  live: boolean; isAdmin: boolean; connected: boolean; refreshFailed: boolean; onRetry: () => void
  error: string | null; done: string | null
}>) {
  const { t } = useTranslation('agents')
  return (
    <>
      {isAdmin && live && !connected && <p className="text-[12px] text-muted">{t('runWorkspace.controls.limited')}</p>}
      {isAdmin && !live && <p className="text-[12px] text-muted">{t('runWorkspace.restartRun.ended')}</p>}
      {refreshFailed && (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-[12px] text-warn">
          {t('runWorkspace.controls.refreshFailed')}
          <button type="button" className="btn btn-ghost btn-sm" onClick={onRetry}>{t('runWorkspace.controls.retry')}</button>
        </p>
      )}
      {error !== null && <p role="alert" className="text-[12px] text-danger">{error}</p>}
      {done !== null && <p role="status" className="text-[12px] text-muted break-words">{done}</p>}
    </>
  )
}

export function RunControlBar({ runId, overview, live, isAdmin, refreshFailed, onRetry }: Readonly<{
  runId: string; overview: EngineeringOverview; live: boolean; isAdmin: boolean
  /** The last read of the run failed: what is shown is the last good one. */
  refreshFailed: boolean
  onRetry: () => void
}>) {
  const { t } = useTranslation('agents')
  const signal = useEngineeringSignal(runId)
  const errorText = useActionError()
  const signalLine = useSignalLine()
  const [stopNow, setStopNow] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const stopSent = signal.isSuccess && STOPS.has(signal.variables.signal)
  const stopping = live && stopSent
  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-medium text-text-strong">{t('engineeringRun.runSignals')}</h2>
        <StatusChip status={overview.run.status} stopping={stopping} paused={live && runPaused(overview.agents)} />
        {isAdmin && live && (
          <LiveControls overview={overview} paused={runPaused(overview.agents)} stopping={stopping}
            send={(name) => { signal.mutate({ signal: name }) }} onStopNow={() => setStopNow(true)} />
        )}
        {isAdmin && !live && (
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRestarting(true)}>
            <RotateCcw size={14} aria-hidden="true" /> {t('runWorkspace.restartRun.open')}
          </button>
        )}
      </div>
      <BarNotes live={live} isAdmin={isAdmin} connected={overview.actions_available} refreshFailed={refreshFailed} onRetry={onRetry}
        error={signal.isError ? errorText(signal.error) : null}
        done={signal.isSuccess
          ? [t(stopSent ? 'runWorkspace.controls.stopSent' : 'engineeringRun.signalSent'), signalLine(signal.data)].filter((part) => part !== '').join(' · ')
          : null} />
      <ConfirmModal isOpen={stopNow} title={t('engineeringRun.stopNowTitle')} message={t('engineeringRun.stopNowMessage')}
        confirmLabel={t('engineeringRun.signals.stop_now')} isLoading={signal.isPending} onCancel={() => setStopNow(false)}
        onConfirm={() => {
          setStopNow(false)
          signal.mutate({ signal: 'stop_now', confirm: true })
        }} />
      {restarting && <RestartRunDialog runId={runId} agents={overview.agents} onClose={() => setRestarting(false)} />}
    </div>
  )
}
