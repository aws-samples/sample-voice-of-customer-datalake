/**
 * @fileoverview A person's Stop of the whole run (7.50.03; the UX spec's "run monitor: Stop"), as the run workspace's
 * control bar (RunWorkspace/RunControlBar.tsx) and an engineering agent's Runs tab show it. It goes through
 * `POST …/stop` (the start function, `useEngineeringStop`), never the signals, so it works where the page cannot reach
 * the runtime or the bus.
 *
 * - `StopControl`: Stop (the agents save a checkpoint, then the run ends; at once when no agent has a session to save,
 *   a run waiting for a person included) with "Stop now, without saving" in its menu, asked first. While a Stop is
 *   under way it is inert (`aria-disabled`, so it keeps its focus).
 * - `StopOutcome`: what the Stop did ("Stopped. 1 open task was closed.") or why it was refused, in a status line kept
 *   in the page from the first render, so it is announced.
 * - `StopProgress`: each agent's part of a Stop under way ("fixer-2 saving a checkpoint…").
 *
 * @module pages/Agents/RunStop
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { UseMutationResult } from '@tanstack/react-query'
import { ChevronDown, Square } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { ActionsMenu } from './RunWorkspace/ActionsMenu'
import { useActionError } from './engineeringRunText'
import type { EngineeringAgent, StopRequest, StopSent } from '../../api/engineeringRunsApi'

/** A Stop of the run, held by whoever shows what it did (`useEngineeringStop`). */
type RunStop = UseMutationResult<StopSent, unknown, StopRequest>

/** What a Stop did, in the reader's words (the answer of `POST …/stop`). */
function useStopText(): (sent: StopSent) => string {
  const { t } = useTranslation('agents')
  return (sent) => {
    if (sent.already) return t('engineeringRun.stop.already', { status: t(`runWorkspace.runs.statuses.${sent.status}`, { defaultValue: sent.status }) })
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
 * which asks first. `stopping`: a Stop is under way (inert, with `aria-disabled`, so it keeps its focus).
 */
export function StopControl({ stop, stopping }: Readonly<{ stop: RunStop; stopping: boolean }>) {
  const { t } = useTranslation('agents')
  const [confirming, setConfirming] = useState(false)
  const inert = stopping || stop.isPending
  return (
    <>
      <span className="inline-flex">
        <button type="button" className="btn btn-secondary btn-sm rounded-r-none" aria-disabled={inert}
          onClick={() => { if (!inert) stop.mutate({ now: false }) }}>
          <Square size={14} aria-hidden="true" /> {t('engineeringRun.signals.shutdown')}
        </button>
        <ActionsMenu label={t('runWorkspace.controls.moreStop')} face={<ChevronDown size={14} aria-hidden="true" />}
          buttonClassName="btn btn-secondary btn-sm rounded-l-none border-l-0 px-1.5"
          actions={[{ id: 'stop_now', label: t('runWorkspace.controls.stopNow'), danger: true, onSelect: () => setConfirming(true) }]} />
      </span>
      <ConfirmModal isOpen={confirming} title={t('engineeringRun.stopNowTitle')} message={t('engineeringRun.stopNowMessage')}
        confirmLabel={t('engineeringRun.signals.stop_now')} isLoading={stop.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          stop.mutate({ now: true })
        }} />
    </>
  )
}

/** Each agent's part of a Stop under way: "fixer-2 saving a checkpoint…", "triage-1: Stopped". */
export function StopProgress({ agents }: Readonly<{ agents: readonly EngineeringAgent[] }>) {
  const { t } = useTranslation('agents')
  const parts = agents.map((agent) => {
    if (agent.status === 'pause_requested') return t('engineeringRun.stop.agentSaving', { agent: agent.agent })
    return t('engineeringRun.agentStatus', { agent: agent.agent, status: t(`engineeringRun.status.${agent.status}`, { defaultValue: agent.status }) })
  })
  return <p role="status" className="text-[12px] text-muted break-words">{[t('runWorkspace.controls.stopSent'), ...parts].join(' · ')}</p>
}
