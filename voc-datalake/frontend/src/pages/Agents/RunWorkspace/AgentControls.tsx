/**
 * @fileoverview An agent's own controls in its session (7.51.00), an admin's on a run under way, through the
 * supervisor's signals (`POST …/signals`) on the agent's task at the attempt it is on, in the run's own words (the
 * control bar's, RunControlBar.tsx): **Stop** (a checkpoint, then the end: `shutdown`), and under ⋯ Save (a checkpoint
 * now), "Stop now, without saving" and Restart, each of the last two asked first; Restart asks where it starts again:
 * from its newest checkpoint, or its task afresh (its work since that checkpoint lost too). An agent whose task is
 * over takes no signal; a task that moved on since is refused (reload).
 *
 * @module pages/Agents/RunWorkspace/AgentControls
 */
import { useState } from 'react'
import { MoreHorizontal, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import RadioChoices from '../../../components/RadioChoices/RadioChoices'
import { RESTART_FROM } from '../../../api/engineeringRunsApi'
import { useEngineeringSignal } from '../useEngineeringRun'
import { useActionError } from '../engineeringRunText'
import { ActionsMenu } from './ActionsMenu'
import type { EngineeringAgent, RestartFrom } from '../../../api/engineeringRunsApi'

type Asking = 'stop_now' | 'restart' | null

export function AgentControls({ runId, agent }: Readonly<{ runId: string; agent: EngineeringAgent }>) {
  const { t } = useTranslation('agents')
  const signal = useEngineeringSignal(runId)
  const errorText = useActionError()
  const [asking, setAsking] = useState<Asking>(null)
  const [from, setFrom] = useState<RestartFrom>('checkpoint')
  const target = { task_id: agent.task_id ?? '', attempt: agent.attempt }
  const name = agent.agent
  return (
    <div className="space-y-1 border-b border-border px-3 py-1.5">
      <div role="group" aria-label={t('engineeringRun.agentSignals', { agent: name })} className="flex flex-wrap items-center gap-1.5">
        <button type="button" className="btn btn-secondary btn-sm" disabled={signal.isPending}
          onClick={() => signal.mutate({ signal: 'shutdown', ...target })}>
          <Square size={14} aria-hidden="true" /> {t('engineeringRun.signals.shutdown')}
        </button>
        <ActionsMenu label={t('runWorkspace.agentControls.more', { agent: name })} face={<MoreHorizontal size={16} aria-hidden="true" />}
          buttonClassName="icon-btn" actions={[
            { id: 'save', label: t('runWorkspace.controls.save'), onSelect: () => signal.mutate({ signal: 'save', ...target }) },
            { id: 'stop_now', label: t('runWorkspace.controls.stopNow'), danger: true, onSelect: () => setAsking('stop_now') },
            { id: 'restart', label: t('runWorkspace.agentControls.restartItem'), onSelect: () => setAsking('restart') },
          ]} />
      </div>
      {signal.isError && <p role="alert" className="text-[12px] text-danger">{errorText(signal.error)}</p>}
      {signal.isSuccess && <p role="status" className="text-[12px] text-muted">{t('engineeringRun.signalSent')}</p>}
      <ConfirmModal isOpen={asking === 'stop_now'} title={t('engineeringRun.stopNowTitle')} message={t('engineeringRun.stopNowAgentMessage')}
        confirmLabel={t('engineeringRun.signals.stop_now')} isLoading={signal.isPending} onCancel={() => setAsking(null)}
        onConfirm={() => {
          setAsking(null)
          signal.mutate({ signal: 'stop_now', confirm: true, ...target })
        }} />
      <ConfirmModal isOpen={asking === 'restart'} variant="warning" title={t('runWorkspace.agentControls.restartTitle', { agent: name })}
        message={t('runWorkspace.agentControls.restartMessage')} confirmLabel={t('runWorkspace.agentControls.restart')}
        isLoading={signal.isPending} onCancel={() => setAsking(null)}
        onConfirm={() => {
          setAsking(null)
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
