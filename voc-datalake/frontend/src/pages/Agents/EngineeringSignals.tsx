/**
 * @fileoverview An admin's signals to a run or to the agent on one of its tasks (`POST …/signals`): Save, Pause,
 * Resume, Shut down, and Stop now, which stops without a checkpoint and so asks first. A signal to an agent carries
 * the attempt the admin saw (the task's lease epoch): when the task has moved on since, the server refuses it and the
 * message says to reload.
 *
 * @module pages/Agents/EngineeringSignals
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { ENGINEERING_SIGNALS } from '../../api/engineeringRunsApi'
import { useEngineeringSignal } from './useEngineeringRun'
import { useActionError } from './engineeringRunText'
import type { EngineeringSignal } from '../../api/engineeringRunsApi'

interface Props {
  runId: string
  /** The agent's task and the attempt seen; absent: the signal goes to the whole run. */
  task?: { taskId: string; attempt: number; agent: string }
}

export function EngineeringSignals({ runId, task }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const signal = useEngineeringSignal(runId)
  const errorText = useActionError()
  const [confirming, setConfirming] = useState(false)
  const target = task === undefined ? {} : { task_id: task.taskId, attempt: task.attempt }
  const send = (name: EngineeringSignal) => {
    if (name === 'stop_now') {
      setConfirming(true)
      return
    }
    signal.mutate({ signal: name, ...target })
  }
  const groupLabel = task === undefined ? t('engineeringRun.runSignals') : t('engineeringRun.agentSignals', { agent: task.agent })
  return (
    <div className="space-y-1">
      <div role="group" aria-label={groupLabel} className="flex flex-wrap gap-1.5">
        {ENGINEERING_SIGNALS.map((name) => (
          <button key={name} type="button" disabled={signal.isPending}
            className={name === 'stop_now' ? 'btn btn-danger btn-sm' : 'btn btn-secondary btn-sm'}
            aria-label={t('engineeringRun.signalFor', { signal: t(`engineeringRun.signals.${name}`), target: groupLabel })}
            onClick={() => send(name)}>
            {t(`engineeringRun.signals.${name}`)}
          </button>
        ))}
      </div>
      {signal.isError && <p role="alert" className="text-[12px] text-danger">{errorText(signal.error)}</p>}
      {signal.isSuccess && (
        <p role="status" className="text-[12px] text-muted break-words">
          {t('engineeringRun.signalSent')}{' '}
          {Object.entries(signal.data.agents).sort(([a], [b]) => a.localeCompare(b)).map(([agent, status]) => (
            t(signal.data.applied[agent] === true ? 'engineeringRun.agentStatus' : 'engineeringRun.agentNotApplied',
              { agent, status: t(`engineeringRun.status.${status}`, { defaultValue: status }) })
          )).join(' · ')}
        </p>
      )}
      <ConfirmModal isOpen={confirming} title={t('engineeringRun.stopNowTitle')} message={t('engineeringRun.stopNowMessage')}
        confirmLabel={t('engineeringRun.signals.stop_now')} isLoading={signal.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false)
          signal.mutate({ signal: 'stop_now', confirm: true, ...target })
        }} />
    </div>
  )
}
