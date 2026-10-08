/**
 * @fileoverview Autonomous agents — the list: each agent's state, scope, last
 * run and spend; admins create agents here (created DISABLED, like the
 * assistant's `create_agent`).
 *
 * @module pages/Agents/Agents
 */
import { useId, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Bot, Loader2, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ModalShell from '../../components/ModalShell/ModalShell'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { failedReads } from '../../utils/failedReads'
import { API_AGENT_LIMITS } from '../../api/agentsApi'
import { useIsAdmin } from '../../store/authStore'
import { RunStatusBadge, ScopeSummary } from './AgentBadges'
import { useAgentList, useCreateAgent } from './useAgents'
import { WorkflowLibrary } from './WorkflowLibrary'
import type { Agent } from '../../api/agentsApi'

function CreateAgentDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const create = useCreateAgent()
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const titleId = useId()
  const nameId = useId()
  const descriptionId = useId()
  const submit = async () => {
    const agent = await create.mutateAsync({
      name: name.trim(), description, scope: { all: true, categories: [], subcategories: [] },
    })
    onClose()
    void navigate(`/agents/${encodeURIComponent(agent.agent_id)}`)
  }
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-md">
      <div className="dialog-header">
        <div>
          <h2 id={titleId} className="dialog-title">{t('list.createTitle')}</h2>
          <p className="dialog-description">{t('list.createHint')}</p>
        </div>
      </div>
      <form className="contents" onSubmit={(e) => { e.preventDefault(); if (name.trim() !== '') void submit().catch(() => undefined) }}>
        <div className="dialog-body space-y-3">
          <div className="space-y-1">
            <label htmlFor={nameId} className="block text-[12px] font-medium text-muted">{t('fields.name')}</label>
            <input id={nameId} className="input w-full" value={name} maxLength={API_AGENT_LIMITS.maxNameChars}
              onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor={descriptionId} className="block text-[12px] font-medium text-muted">{t('fields.description')}</label>
            <textarea id={descriptionId} rows={3} className="input w-full" value={description}
              maxLength={API_AGENT_LIMITS.maxDescriptionChars} onChange={(e) => setDescription(e.target.value)} />
          </div>
          {create.isError && <p role="alert" className="text-[12px] text-danger">{t('list.createFailed')}</p>}
        </div>
        <div className="dialog-footer">
          <button type="button" className="btn btn-secondary" onClick={onClose}>{t('common.cancel')}</button>
          <button type="submit" className="btn btn-primary" disabled={create.isPending || name.trim() === ''}>
            {create.isPending && <Loader2 size={14} className="animate-spin" aria-hidden="true" />} {t('list.create')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}

function AgentRow({ agent }: Readonly<{ agent: Agent }>) {
  const { t } = useTranslation('agents')
  const { stats } = agent
  return (
    <li>
      <Link to={`/agents/${encodeURIComponent(agent.agent_id)}`}
        className="card p-4 flex flex-wrap items-center gap-3 hover:border-border-strong transition-colors">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-subtle text-accent-text">
          <Bot size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-strong truncate" title={agent.name}>{agent.name}</p>
          <p className="text-[12px] text-muted truncate" title={agent.description === '' ? undefined : agent.description}>{agent.description === '' ? <ScopeSummary scope={agent.scope} /> : agent.description}</p>
        </div>
        <span className={agent.enabled ? 'badge badge-ok' : 'badge badge-muted'}>
          {agent.enabled ? t('status.enabled') : t('status.disabled')}
        </span>
        {stats.last_run_status !== null && <RunStatusBadge status={stats.last_run_status} />}
        <span className="text-[12px] text-muted font-mono" title={t('list.spendHint')}>
          {t('list.spend', { runs: stats.scheduled_runs_today, calls: stats.model_calls_this_month })}
        </span>
      </Link>
    </li>
  )
}

export default function Agents() {
  const { t } = useTranslation('agents')
  const isAdmin = useIsAdmin()
  const listQuery = useAgentList()
  const { data, isLoading } = listQuery
  const failure = failedReads([listQuery])
  const [creating, setCreating] = useState(false)
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('list.title')}</h1>
          <p className="text-sm text-muted mt-1 max-w-prose">{t('list.subtitle')}</p>
        </div>
        {isAdmin && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden="true" /> {t('list.create')}
          </button>
        )}
      </div>
      {isLoading && <div className="skeleton h-24" />}
      {failure.loadFailed && <LoadFailed message={t('list.loadFailed')} onRetry={failure.retry} retrying={failure.retrying} />}
      {data?.length === 0 && (
        <div className="card text-center py-10">
          <Bot size={20} className="mx-auto text-muted" aria-hidden="true" />
          <p className="mt-2 text-sm font-semibold text-text-strong">{t('list.emptyTitle')}</p>
          <p className="text-sm text-muted">{isAdmin ? t('list.emptyAdmin') : t('list.emptyUser')}</p>
        </div>
      )}
      {data !== undefined && data.length > 0 && (
        <ul className="space-y-2">{data.map((agent) => <AgentRow key={agent.agent_id} agent={agent} />)}</ul>
      )}
      {isAdmin && <WorkflowLibrary />}
      {creating && <CreateAgentDialog onClose={() => setCreating(false)} />}
    </div>
  )
}
