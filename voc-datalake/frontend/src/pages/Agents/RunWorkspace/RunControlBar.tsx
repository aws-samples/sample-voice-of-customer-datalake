/**
 * @fileoverview The run's control bar (7.51.00; the UX audit's S8 and S9), in the workspace's header: the run's
 * status chip, then, for an admin on a run under way, **Pause** or **Resume** (one toggle, by the run's state),
 * **Stop** with "Stop now, without saving" in its menu (asked first), and Save a checkpoint under ⋯; on an ended run,
 * **Restart run** (a child run, RestartRunDialog.tsx).
 *
 * Stop is the run's Stop (7.50.03, RunStop.tsx: `POST …/stop`, through the start function), never a signal; it is
 * there on every run that has not ended wherever the deployment names the start function (`stop_available`), and a
 * line says so where it does not. Pause, Resume and Save are signals, which go through the start function too since
 * 7.51.02: they show by their own flag (`signals_available`), and a line says why they are missing where it is off.
 * While a Stop is under way (the run's `stop`)
 * the chip reads Stopping…, Stop is inert, Pause, Resume and Save are gone, and a status line says each agent's part;
 * what this page's Stop did stays said, on the ended run too. A read of the run that failed keeps the bar (its last
 * good state), with Retry.
 *
 * @module pages/Agents/RunWorkspace/RunControlBar
 */
import { useId, useState } from 'react'
import { Loader2, MoreHorizontal, Pause, Play, RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useEngineeringSignal, useEngineeringStop } from '../useEngineeringRun'
import { isStopping, useActionError } from '../engineeringRunText'
import { StopControl, StopOutcome, StopProgress } from '../RunStop'
import { ActionsMenu } from './ActionsMenu'
import { RestartRunDialog } from './RestartRunDialog'
import { statusChipClass } from './agentStatus'
import type { EngineeringAgent, EngineeringOverview, SignalSent } from '../../../api/engineeringRunsApi'

/** The agents' statuses that are over (they take no signal), and the ones of a pause. */
const ENDED = new Set(['done', 'failed', 'stopped'])
const PAUSED = new Set(['paused', 'pause_requested'])

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

/** The controls of a run under way: the signals where they reach it (not while it stops), and its Stop. */
function LiveControls({ overview, stopping, stop, send }: Readonly<{
  overview: EngineeringOverview; stopping: boolean; stop: ReturnType<typeof useEngineeringStop>
  send: (signal: 'pause' | 'resume' | 'save') => void
}>) {
  const { t } = useTranslation('agents')
  const signals = overview.signals_available && !stopping
  // (a run waiting for a person, or every agent at it paused, is resumed)
  const resume = overview.run.status === 'needs_human' || runPaused(overview.agents)
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {signals && (
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => send(resume ? 'resume' : 'pause')}>
          {resume ? <Play size={14} aria-hidden="true" /> : <Pause size={14} aria-hidden="true" />}
          {t(resume ? 'engineeringRun.signals.resume' : 'engineeringRun.signals.pause')}
        </button>
      )}
      {overview.stop_available && <StopControl stop={stop} stopping={stopping} />}
      {signals && (
        <ActionsMenu label={t('runWorkspace.controls.more')} face={<MoreHorizontal size={16} aria-hidden="true" />} buttonClassName="icon-btn"
          actions={[{ id: 'save', label: t('runWorkspace.controls.save'), onSelect: () => send('save') }]} />
      )}
    </div>
  )
}

/** The bar's lines: why some controls are missing, the ended run's way on, a failed read, and what a signal did. */
function BarNotes({ live, isAdmin, overview, refreshFailed, onRetry, error, done }: Readonly<{
  live: boolean; isAdmin: boolean; overview: EngineeringOverview; refreshFailed: boolean; onRetry: () => void
  error: string | null; done: string | null
}>) {
  const { t } = useTranslation('agents')
  const admin = (shown: boolean) => isAdmin && shown
  return (
    <>
      {admin(live && !overview.signals_available) && <p className="text-[12px] text-muted">{t('runWorkspace.controls.limited')}</p>}
      {admin(live && !overview.stop_available) && <p className="text-[12px] text-muted">{t('engineeringRun.stop.unavailable')}</p>}
      {admin(!live) && <p className="text-[12px] text-muted">{t('runWorkspace.restartRun.ended')}</p>}
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

/** Restart run, on an ended run: a child run (RestartRunDialog.tsx). */
function RestartRun({ runId, agents }: Readonly<{ runId: string; agents: readonly EngineeringAgent[] }>) {
  const { t } = useTranslation('agents')
  const [restarting, setRestarting] = useState(false)
  return (
    <>
      <button type="button" className="btn btn-secondary btn-sm" onClick={() => setRestarting(true)}>
        <RotateCcw size={14} aria-hidden="true" /> {t('runWorkspace.restartRun.open')}
      </button>
      {restarting && <RestartRunDialog runId={runId} agents={agents} onClose={() => setRestarting(false)} />}
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
  const stop = useEngineeringStop(runId)
  const errorText = useActionError()
  const signalLine = useSignalLine()
  const headingId = useId()
  const stopping = live && isStopping(overview.run)
  return (
    <section className="space-y-1.5 border-t border-border pt-3" aria-labelledby={headingId}>
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={headingId} className="text-sm font-medium text-text-strong">{t('engineeringRun.runSignals')}</h2>
        <StatusChip status={overview.run.status} stopping={stopping} paused={live && runPaused(overview.agents)} />
        {isAdmin && live && (
          <LiveControls overview={overview} stopping={stopping} stop={stop} send={(name) => { signal.mutate({ signal: name }) }} />
        )}
        {isAdmin && !live && <RestartRun runId={runId} agents={overview.agents} />}
      </div>
      <BarNotes live={live} isAdmin={isAdmin} overview={overview} refreshFailed={refreshFailed} onRetry={onRetry}
        error={signal.isError ? errorText(signal.error) : null}
        done={signal.isSuccess ? [t('engineeringRun.signalSent'), signalLine(signal.data)].filter((part) => part !== '').join(' · ') : null} />
      {/* (what this page's Stop did stays said once the run has ended) */}
      {isAdmin && <StopOutcome stop={stop} />}
      {isAdmin && stopping && <StopProgress agents={overview.agents} />}
    </section>
  )
}
