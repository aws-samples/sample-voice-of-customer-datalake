/**
 * @fileoverview An agent's own controls in its session (7.51.00), an admin's on a run under way, through the
 * supervisor's signals (`POST …/signals`) on the agent's task at the attempt it is on: Save (a checkpoint now), Stop
 * (shut down, after a checkpoint) and Restart, which asks first where it starts again: from its newest checkpoint, or
 * its task afresh (its work since that checkpoint lost too). A task that moved on since is refused (reload).
 *
 * @module pages/Agents/RunWorkspace/AgentControls
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import RadioChoices from '../../../components/RadioChoices/RadioChoices'
import { RESTART_FROM } from '../../../api/engineeringRunsApi'
import { useEngineeringSignal } from '../useEngineeringRun'
import { useActionError } from '../engineeringRunText'
import type { EngineeringAgent, RestartFrom } from '../../../api/engineeringRunsApi'

export function AgentControls({ runId, agent }: Readonly<{ runId: string; agent: EngineeringAgent }>) {
  const { t } = useTranslation('agents')
  const signal = useEngineeringSignal(runId)
  const errorText = useActionError()
  const [restarting, setRestarting] = useState(false)
  const [from, setFrom] = useState<RestartFrom>('checkpoint')
  if (agent.task_id === null || agent.attempt < 1) return null
  const target = { task_id: agent.task_id, attempt: agent.attempt }
  const name = agent.agent
  return (
    <div className="space-y-1 border-b border-border px-3 py-1.5">
      <div role="group" aria-label={t('engineeringRun.agentSignals', { agent: name })} className="flex flex-wrap gap-1.5">
        <button type="button" className="btn btn-secondary btn-sm" disabled={signal.isPending}
          onClick={() => signal.mutate({ signal: 'save', ...target })}>{t('runWorkspace.agentControls.save')}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={signal.isPending}
          onClick={() => signal.mutate({ signal: 'shutdown', ...target })}>{t('runWorkspace.agentControls.stop')}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={signal.isPending}
          onClick={() => setRestarting(true)}>{t('runWorkspace.agentControls.restart')}</button>
      </div>
      {signal.isError && <p role="alert" className="text-[12px] text-danger">{errorText(signal.error)}</p>}
      {signal.isSuccess && <p role="status" className="text-[12px] text-muted">{t('engineeringRun.signalSent')}</p>}
      <ConfirmModal isOpen={restarting} variant="warning" title={t('runWorkspace.agentControls.restartTitle', { agent: name })}
        message={t('runWorkspace.agentControls.restartMessage')} confirmLabel={t('runWorkspace.agentControls.restart')}
        isLoading={signal.isPending} onCancel={() => setRestarting(false)}
        onConfirm={() => {
          setRestarting(false)
          signal.mutate({ signal: 'restart', from, confirm: true, ...target })
        }}>
        <div className="mt-3">
          <RadioChoices legend={t('runWorkspace.agentControls.from')} choices={RESTART_FROM} value={from} onChange={setFrom}
            display={(choice) => t(`runWorkspace.agentControls.fromChoices.${choice}`)}
            legendClassName="text-sm font-medium text-text-strong" rowClassName="space-y-1" labelClassName="flex items-center gap-2 text-sm" />
        </div>
      </ConfirmModal>
    </div>
  )
}
