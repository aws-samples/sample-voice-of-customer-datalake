/**
 * @fileoverview The run monitor's controls of the whole run (7.50.03; the UX spec's "run monitor: Stop").
 *
 * - **Stop** is always there for an admin on a run that has not ended, whatever the deployment wires: a split button
 *   whose Stop has the agents save a checkpoint, then ends the run (at once when no agent has a session to save, a run
 *   waiting for a person included), and whose menu holds "Stop now, without saving", which asks first. It goes through
 *   `POST …/stop` (the start function), never the signals, so it works where the monitor cannot reach the runtime.
 * - **Stopping…**: while a Stop waits for its agents' checkpoints, the run's chip says so, Stop is disabled
 *   (`aria-disabled`), and a status line says each agent's progress ("fixer-2 saving a checkpoint…").
 * - Where the signals reach the run (`actions_available`): one Pause/Resume toggle by the run's state, and Save a
 *   checkpoint in the ⋯ menu. Where they do not, one line says so, beside Stop.
 *
 * - What a Stop did stays said once the run has ended (the Stop's answer is held by the bar, which stays for it).
 *
 * `RunStatusChip` is the run's toned status (running accent, waiting for a person warn, stopping warn with a spinner,
 * done ok, failed danger, stopped muted; engineeringRunText.ts `runState`). `StopControl` is the split button alone,
 * on a Stop its caller holds (`useEngineeringStop`), with `StopOutcome` what it did; an engineering agent's Runs tab
 * shows both for its live run too.
 *
 * @module pages/Agents/RunControlBar
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UseMutationResult } from '@tanstack/react-query'
import { CheckCircle2, ChevronDown, CircleDot, Hand, Loader2, Pause, Play, Save, Square, XCircle } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import MoreMenu from '../../assistant/components/MoreMenu'
import { IconBadge } from '../../components/IconBadge/IconBadge'
import { ENDED_RUN_STATUSES } from '../../api/engineeringRunsApi'
import { useEngineeringSignal, useEngineeringStop } from './useEngineeringRun'
import { SignalOutcome } from './EngineeringSignals'
import { isStopping, runState, useActionError } from './engineeringRunText'
import type { RunState } from './engineeringRunText'
import type { EngineeringAgent, EngineeringOverview, StopRequest, StopSent } from '../../api/engineeringRunsApi'

type Run = EngineeringOverview['run']
/** A Stop of the run, held by whoever shows what it did (`useEngineeringStop`). */
export type RunStop = UseMutationResult<StopSent, unknown, StopRequest>

const RUN_TONES: Readonly<Record<RunState, { toneClass: string; icon: LucideIcon; spin?: boolean }>> = {
  running: { toneClass: 'badge-accent', icon: CircleDot },
  waiting: { toneClass: 'badge-warn', icon: Hand },
  stopping: { toneClass: 'badge-warn', icon: Loader2, spin: true },
  done: { toneClass: 'badge-ok', icon: CheckCircle2 },
  failed: { toneClass: 'badge-danger', icon: XCircle },
  stopped: { toneClass: 'badge-muted', icon: Square },
}

export function RunStatusChip({ run }: Readonly<{ run: Pick<Run, 'status' | 'stop'> }>) {
  const { t } = useTranslation('agents')
  const state = runState(run)
  if (state === null) return <span className="badge badge-muted">{run.status || t('engineeringRun.statusUnknown')}</span>
  const { toneClass, icon, spin } = RUN_TONES[state]
  return <IconBadge toneClass={toneClass} icon={icon} spin={spin}>{t(`engineeringRun.runState.${state}`)}</IconBadge>
}

/** What a Stop did, in the reader's words (the answer of `POST …/stop`). */
function useStopText(): (sent: StopSent) => string {
  const { t } = useTranslation('agents')
  return (sent) => {
    if (sent.already) return t('engineeringRun.stop.already', { status: t(`engineeringRun.runState.${sent.status}`, { defaultValue: sent.status }) })
    if (sent.status === 'stopping') return t('engineeringRun.stop.stopping', { agents: sent.saving.join(', ') })
    const parts = [sent.fell_back ? t('engineeringRun.stop.fellBack') : t('engineeringRun.stop.stopped', { count: sent.tasks_closed.length })]
    if (sent.agent_run?.ended === true) parts.push(t('engineeringRun.stop.agentRunEnded'))
    return parts.join(' ')
  }
}

/** What a Stop did (a status line, kept in the page from the first render so it is announced), or why not. */
export function StopOutcome({ stop }: Readonly<{ stop: RunStop }>) {
  const errorText = useActionError()
  const stopText = useStopText()
  return (
    <>
      {stop.isError && <p role="alert" className="text-[12px] text-danger break-words">{errorText(stop.error)}</p>}
      <p role="status" className="text-[12px] text-muted break-words">{stop.isSuccess ? stopText(stop.data) : ''}</p>
    </>
  )
}

/**
 * The Stop split button on `stop`: Stop (the agents save, then the run ends) and its menu's "Stop now, without saving",
 * which asks first. `stopping`: a Stop is under way (disabled, with `aria-disabled`, so it keeps its focus).
 */
export function StopControl({ stop, stopping }: Readonly<{ stop: RunStop; stopping: boolean }>) {
  const { t } = useTranslation('agents')
  const [confirming, setConfirming] = useState(false)
  const disabled = stopping || stop.isPending
  return (
    <div className="space-y-1 min-w-0">
      <div role="group" aria-label={t('engineeringRun.stop.group')} className="inline-flex items-stretch">
        <button type="button" className="btn btn-danger btn-sm rounded-r-none" aria-disabled={disabled}
          onClick={() => { if (!disabled) stop.mutate({ now: false }) }}>
          {disabled ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Square size={14} aria-hidden />}
          {stopping ? t('engineeringRun.stop.stoppingButton') : t('engineeringRun.signals.shutdown')}
        </button>
        <MoreMenu label={t('engineeringRun.stop.more')} triggerClassName="btn btn-danger btn-sm rounded-l-none border-l-0 px-2"
          triggerIcon={<ChevronDown size={14} aria-hidden />}
          items={[{ key: 'stop_now', label: t('engineeringRun.stop.nowItem'), icon: <Square size={14} />, danger: true,
            disabled: stop.isPending, onSelect: () => setConfirming(true) }]} />
      </div>
      <ConfirmModal isOpen={confirming} title={t('engineeringRun.stopNowTitle')} message={t('engineeringRun.stopNowMessage')}
        confirmLabel={t('engineeringRun.signals.stop_now')} isLoading={stop.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          stop.mutate({ now: true })
        }} />
    </div>
  )
}

/** Each agent's part of a Stop under way: "fixer-2 saving a checkpoint…", "triage-1 stopped". */
function StopProgress({ agents }: Readonly<{ agents: readonly EngineeringAgent[] }>) {
  const { t } = useTranslation('agents')
  const parts = agents.map((agent) => {
    if (agent.status === 'pause_requested') return t('engineeringRun.stop.agentSaving', { agent: agent.agent })
    return t('engineeringRun.agentStatus', { agent: agent.agent, status: t(`engineeringRun.status.${agent.status}`, { defaultValue: agent.status }) })
  })
  return <p role="status" className="text-[12px] text-muted break-words">{[t('engineeringRun.stop.sent'), ...parts].join(' · ')}</p>
}

/** Pause or Resume, by the run's state: a run waiting for a person, or with a paused agent, is resumed. */
function PauseResume({ runId, run, agents }: Readonly<{ runId: string; run: Run; agents: readonly EngineeringAgent[] }>) {
  const { t } = useTranslation('agents')
  const signal = useEngineeringSignal(runId)
  const resume = run.status === 'needs_human' || agents.some((agent) => agent.status === 'paused')
  const name = resume ? 'resume' : 'pause'
  return (
    <div className="space-y-1">
      <button type="button" className="btn btn-secondary btn-sm" disabled={signal.isPending}
        onClick={() => signal.mutate({ signal: name })}>
        {resume ? <Play size={14} aria-hidden /> : <Pause size={14} aria-hidden />}
        {t(`engineeringRun.signals.${name}`)}
      </button>
      <SignalOutcome signal={signal} />
    </div>
  )
}

function SaveMenu({ runId }: Readonly<{ runId: string }>) {
  const { t } = useTranslation('agents')
  const signal = useEngineeringSignal(runId)
  return (
    <div className="space-y-1">
      <MoreMenu label={t('engineeringRun.moreRun')}
        items={[{ key: 'save', label: t('engineeringRun.saveCheckpoint'), icon: <Save size={14} />,
          disabled: signal.isPending, onSelect: () => signal.mutate({ signal: 'save' }) }]} />
      <SignalOutcome signal={signal} />
    </div>
  )
}

/**
 * The bar above the run's flow, for an admin on a run that has not ended: Stop always (when the deployment names the
 * start function), Pause/Resume and Save where the signals reach the run, each agent's part of a Stop under way. Once
 * the run has ended, only what this page's Stop did (nothing when it did not end it here).
 */
export function RunControlBar({ runId, overview }: Readonly<{ runId: string; overview: EngineeringOverview }>) {
  const { t } = useTranslation('agents')
  const stop = useEngineeringStop(runId)
  const { run, agents } = overview
  if (ENDED_RUN_STATUSES.includes(run.status) || run.ended_at !== null) {
    return stop.isSuccess ? <section className="card" aria-label={t('engineeringRun.runSignals')}><StopOutcome stop={stop} /></section> : null
  }
  const stopping = isStopping(run)
  const signals = overview.actions_available && !stopping
  return (
    <section className="card space-y-2" aria-labelledby="engineering-run-controls">
      <div className="flex flex-wrap items-start gap-2">
        <h2 id="engineering-run-controls" className="mr-auto self-center text-sm font-medium text-text-strong">
          {t('engineeringRun.runSignals')}
        </h2>
        {signals && <PauseResume runId={runId} run={run} agents={agents} />}
        {overview.stop_available
          ? <StopControl stop={stop} stopping={stopping} />
          : <p className="self-center text-[12px] text-muted">{t('engineeringRun.stop.unavailable')}</p>}
        {signals && <SaveMenu runId={runId} />}
      </div>
      <StopOutcome stop={stop} />
      {stopping && <StopProgress agents={agents} />}
      {!overview.actions_available && <p className="text-[12px] text-muted">{t('engineeringRun.actionsUnavailable')}</p>}
    </section>
  )
}
