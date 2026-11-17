/**
 * @fileoverview An admin's signals to the agent on one of a run's tasks (`POST …/signals`), on its card in the Agents
 * panel (7.50.03, the UX spec's "run monitor": Stop and ⋯, the run's own words): **Stop** (the agent saves a checkpoint,
 * then stops: the Shut down signal) and a ⋯ menu with Save a checkpoint, Pause or Resume (by the agent's status: a
 * paused agent is resumed, which continues it from its checkpoint) and Stop now, without saving, which asks first. A
 * signal carries the attempt the admin saw (the task's lease epoch): when the task has moved on since, the server
 * refuses it and the message says to reload. The whole run's controls are RunControlBar.tsx's; without a task this
 * sends the same signals to the whole run.
 *
 * `SignalOutcome` says what a signal did (each agent's status, and which ones it did nothing to) or why it was refused.
 *
 * @module pages/Agents/EngineeringSignals
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Pause, Play, Save, Square } from 'lucide-react'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import MoreMenu from '../../assistant/components/MoreMenu'
import { useEngineeringSignal } from './useEngineeringRun'
import { useActionError } from './engineeringRunText'
import type { EngineeringSignal } from '../../api/engineeringRunsApi'

/** What `SignalOutcome` reads of a signal's mutation. */
interface SignalState {
  isError: boolean
  error: unknown
  isSuccess: boolean
  data?: { agents: Record<string, string>; applied: Record<string, boolean> }
}

/** What a signal did, or why it was refused (an alert). */
export function SignalOutcome({ signal }: Readonly<{ signal: SignalState }>) {
  const { t } = useTranslation('agents')
  const errorText = useActionError()
  if (signal.isError) return <p role="alert" className="text-[12px] text-danger break-words">{errorText(signal.error)}</p>
  if (!signal.isSuccess || signal.data === undefined) return null
  const { agents, applied } = signal.data
  return (
    <p role="status" className="text-[12px] text-muted break-words">
      {t('engineeringRun.signalSent')}{' '}
      {Object.entries(agents).sort(([a], [b]) => a.localeCompare(b)).map(([agent, status]) => (
        t(applied[agent] === true ? 'engineeringRun.agentStatus' : 'engineeringRun.agentNotApplied',
          { agent, status: t(`engineeringRun.status.${status}`, { defaultValue: status }) })
      )).join(' · ')}
    </p>
  )
}

interface Props {
  runId: string
  /** The agent's task, the attempt seen and the agent's status; absent: the signal goes to the whole run. */
  task?: { taskId: string; attempt: number; agent: string; status?: string }
}

export function EngineeringSignals({ runId, task }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const signal = useEngineeringSignal(runId)
  const [confirming, setConfirming] = useState(false)
  const target = task === undefined ? {} : { task_id: task.taskId, attempt: task.attempt }
  const send = (name: EngineeringSignal) => signal.mutate({ signal: name, ...target })
  const groupLabel = task === undefined ? t('engineeringRun.runSignals') : t('engineeringRun.agentSignals', { agent: task.agent })
  const label = (name: EngineeringSignal) => t('engineeringRun.signalFor', { signal: t(`engineeringRun.signals.${name}`), target: groupLabel })
  const toggle: EngineeringSignal = task?.status === 'paused' ? 'resume' : 'pause'
  return (
    <div className="space-y-1">
      <div role="group" aria-label={groupLabel} className="flex flex-wrap items-center gap-1.5">
        <button type="button" disabled={signal.isPending} className="btn btn-danger btn-sm" aria-label={label('shutdown')}
          onClick={() => send('shutdown')}>
          <Square size={14} aria-hidden /> {t('engineeringRun.signals.shutdown')}
        </button>
        <MoreMenu label={t('engineeringRun.moreFor', { target: groupLabel })} items={[
          { key: 'save', label: t('engineeringRun.saveCheckpoint'), icon: <Save size={14} />, disabled: signal.isPending,
            onSelect: () => send('save') },
          { key: toggle, label: t(`engineeringRun.signals.${toggle}`), icon: toggle === 'resume' ? <Play size={14} /> : <Pause size={14} />,
            disabled: signal.isPending, onSelect: () => send(toggle) },
          { key: 'stop_now', label: t('engineeringRun.stop.nowItem'), icon: <Square size={14} />, danger: true,
            disabled: signal.isPending, onSelect: () => setConfirming(true) },
        ]} />
      </div>
      <SignalOutcome signal={signal} />
      <ConfirmModal isOpen={confirming} title={t('engineeringRun.stopNowTitle')} message={t('engineeringRun.stopNowAgentMessage')}
        confirmLabel={t('engineeringRun.signals.stop_now')} isLoading={signal.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          signal.mutate({ signal: 'stop_now', confirm: true, ...target })
        }} />
    </div>
  )
}
