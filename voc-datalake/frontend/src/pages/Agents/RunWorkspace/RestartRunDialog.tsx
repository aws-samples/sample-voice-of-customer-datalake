/**
 * @fileoverview Restart run (7.51.00): an ended run (stopped, spent, past its 30 days) started again as a CHILD run
 * (`POST …/restart`, D51-3: reopening it would break its record, its 30-day limit and its budget). The admin
 * chooses how (resume: each agent from its newest checkpoint; restart: their tasks afresh), which agents (none
 * ticked: every unfinished task's), and on which commit (the run's own, or the repository's head now, rebased by the
 * harness, a conflict reaching the agent as data), and (7.58.00) optionally one model for every role of the new run
 * (ModelChoiceField.tsx, as Run now's; none: the run's own models), so a step Kiro stopped for its model goes on with
 * another. The child opens once it is started; an answer that could not be read names the child to open, never to
 * start twice.
 *
 * @module pages/Agents/RunWorkspace/RestartRunDialog
 */
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import RadioChoices from '../../../components/RadioChoices/RadioChoices'
import { ApiError } from '../../../lib/errors'
import { RESTART_BASES, RESTART_MODES } from '../../../api/engineeringRunWorkspaceApi'
import { useActionError } from '../engineeringRunText'
import { ModelChoiceField } from '../ModelChoiceField'
import { draftOf, modelChoiceOf, modelIssue } from '../modelChoice'
import { useRestartRun } from './useRunWorkspace'
import { runWorkspacePath } from './runWorkspacePaths'
import type { RestartBase, RestartMode } from '../../../api/engineeringRunWorkspaceApi'
import type { EngineeringAgent } from '../../../api/engineeringRunsApi'

interface Props {
  runId: string
  agents: readonly EngineeringAgent[]
  onClose: () => void
}

const RADIO = { legendClassName: 'text-sm font-medium text-text-strong', rowClassName: 'space-y-1', labelClassName: 'flex items-center gap-2 text-sm' }

export function RestartRunDialog({ runId, agents, onClose }: Readonly<Props>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const restart = useRestartRun(runId)
  const errorText = useActionError()
  const [mode, setMode] = useState<RestartMode>('resume')
  const [base, setBase] = useState<RestartBase>('same')
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set())
  const [model, setModel] = useState(draftOf(null))
  const toggle = (agent: string) => {
    setChosen((before) => new Set(before.has(agent) ? [...before].filter((id) => id !== agent) : [...before, agent]))
  }
  const confirm = () => {
    if (modelIssue(model) !== null) return   // (the model field says what is wrong with it)
    const named = agents.map((agent) => agent.agent).filter((agent) => chosen.has(agent))
    const picked = modelChoiceOf(model)
    restart.mutate({ mode, base, ...(named.length === 0 ? {} : { agents: named }), ...(picked === null ? {} : { model: picked }) }, {
      onSuccess: (child) => {
        onClose()
        void navigate(runWorkspacePath(child))
      },
    })
  }
  const started = restart.error instanceof ApiError ? restart.error.runId : undefined
  return (
    <ConfirmModal isOpen variant="warning" title={t('runWorkspace.restartRun.title')} message={t('runWorkspace.restartRun.message')}
      confirmLabel={t('runWorkspace.restartRun.confirm')} isLoading={restart.isPending} confirmDisabled={started !== undefined}
      onCancel={onClose} onConfirm={confirm}>
      <div className="mt-3 space-y-3">
        <RadioChoices legend={t('runWorkspace.restartRun.mode')} choices={RESTART_MODES} value={mode} onChange={setMode}
          display={(choice) => t(`runWorkspace.restartRun.modes.${choice}`)} {...RADIO} />
        <RadioChoices legend={t('runWorkspace.restartRun.base')} choices={RESTART_BASES} value={base} onChange={setBase}
          display={(choice) => t(`runWorkspace.restartRun.bases.${choice}`)} {...RADIO} />
        {agents.length > 0 && (
          <fieldset className="space-y-1">
            <legend className={RADIO.legendClassName}>{t('runWorkspace.restartRun.agents')}</legend>
            <p className="text-[12px] text-muted">{t('runWorkspace.restartRun.agentsHint')}</p>
            {agents.map((agent) => (
              <label key={agent.agent} className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={chosen.has(agent.agent)} onChange={() => toggle(agent.agent)} />
                <span className="font-mono">{agent.agent}</span>
                {agent.role !== '' && <span className="text-muted">{agent.role}</span>}
              </label>
            ))}
          </fieldset>
        )}
        <ModelChoiceField label={t('runWorkspace.restartRun.model')} defaultLabel={t('runWorkspace.restartRun.modelDefault')}
          draft={model} onChange={setModel} harness="any" disabled={restart.isPending} />
        {restart.isError && (
          <p role="alert" className="text-[12px] text-danger">
            {errorText(restart.error)}
            {started !== undefined && <> <Link className="link font-medium" to={runWorkspacePath(started)}>{t('startRun.openRun')}</Link></>}
          </p>
        )}
      </div>
    </ConfirmModal>
  )
}
