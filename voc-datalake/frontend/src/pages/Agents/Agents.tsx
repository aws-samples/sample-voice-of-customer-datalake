/**
 * @fileoverview Autonomous agents — the list: each agent's state, scope, last
 * run and spend; admins create agents here (created DISABLED, like the
 * assistant's `create_agent`). Admins also get a Workflows tab (`?tab=workflows`,
 * where `/agents/workflows` lands): the workflow library.
 *
 * @module pages/Agents/Agents
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Bot, Hand, Plus, Workflow } from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { NameDialog } from '../../components/NameDialog/NameDialog'
import { failedReads } from '../../utils/failedReads'
import { API_AGENT_LIMITS } from '../../api/agentsApi'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { useIsAdmin } from '../../store/authStore'
import { RunStatusBadge, ScopeSummary } from './AgentBadges'
import { useAgentList, useCreateAgent } from './useAgents'
import { WorkflowLibrary } from './WorkflowLibrary'
import { AgentRowActions } from './AgentRowActions'
import { PlansList } from './PlansList'
import type { LucideIcon } from 'lucide-react'
import type { Agent } from '../../api/agentsApi'

const agentPath = (agentId: string) => `/agents/${encodeURIComponent(agentId)}`

function CreateAgentDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const create = useCreateAgent()
  const submit = (name: string, description: string) => {
    create.mutate({ name, description, scope: { all: true, categories: [], subcategories: [] } }, {
      onSuccess: (agent) => {
        onClose()
        void navigate(agentPath(agent.agent_id))
      },
    })
  }
  return (
    <NameDialog title={t('list.createTitle')} hint={t('list.createHint')} submitLabel={t('list.create')} initialName=""
      label={t('fields.name')} maxLength={API_AGENT_LIMITS.maxNameChars}
      description={{ label: t('fields.description'), maxLength: API_AGENT_LIMITS.maxDescriptionChars }}
      saving={create.isPending} error={create.isError ? t('list.createFailed') : undefined}
      onSave={submit} onClose={onClose} />
  )
}

function AgentRow({ agent, isAdmin }: Readonly<{ agent: Agent; isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  const { stats } = agent
  const needsDecision = stats.last_run_status === 'needs_human'
  return (
    <li className="space-y-1">
      <div className="flex items-stretch gap-2">
      <Link to={agentPath(agent.agent_id)}
        className="card p-4 flex min-w-0 flex-1 flex-wrap items-center gap-3 hover:border-border-strong transition-colors">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-accent-subtle text-accent-text">
          <Bot size={18} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-text-strong break-words [overflow-wrap:anywhere]">{agent.name}</p>
          <p className="text-[12px] text-muted line-clamp-3 break-words [overflow-wrap:anywhere]" title={agent.description === '' ? undefined : agent.description}>{agent.description === '' ? <ScopeSummary scope={agent.scope} /> : agent.description}</p>
        </div>
        {needsDecision && <span className="badge badge-warn">{t('list.needsDecision')}</span>}
        <span className={agent.enabled ? 'badge badge-ok' : 'badge badge-muted'}>
          {agent.enabled ? t('status.enabled') : t('status.disabled')}
        </span>
        {stats.last_run_status !== null && <RunStatusBadge status={stats.last_run_status} />}
        <span className="text-[12px] text-muted font-mono" title={t('list.spendHint')}>
          {t('list.spend', { runs: stats.scheduled_runs_today, calls: stats.model_calls_this_month })}
        </span>
      </Link>
      {isAdmin && <AgentRowActions agent={agent} />}
      </div>
      {/* Beside the row, not inside it: a link cannot hold another link. */}
      {needsDecision && (
        <Link to={`${agentPath(agent.agent_id)}?tab=runs`} className="ml-4 inline-flex items-center gap-1 text-[12px] link">
          <Hand size={13} aria-hidden="true" /> {t('list.reviewRun', { name: agent.name })}
        </Link>
      )}
    </li>
  )
}

const VIEWS = ['agents', 'workflows'] as const
type AgentsView = (typeof VIEWS)[number]
const VIEW_ICONS: Readonly<Record<AgentsView, LucideIcon>> = { agents: Bot, workflows: Workflow }

/** `?tab=` picks the view (`/agents/workflows` lands on the library); only admins have the library. */
function parseView(value: string | null, isAdmin: boolean): AgentsView {
  return isAdmin && value === 'workflows' ? 'workflows' : 'agents'
}

function ViewTabs({ view, onChange }: Readonly<{ view: AgentsView; onChange: (view: AgentsView) => void }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  // The library's list is read before the tab opens, so the first switch renders from cache.
  const warm = (id: AgentsView) => {
    if (id === 'workflows') void queryClient.prefetchQuery({ queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, staleTime: 30_000 })
  }
  return (
    <div className="tabs-rail overflow-x-auto">
      <div className="tabs-track" role="tablist" aria-label={t('views.label')}>
        {VIEWS.map((id) => {
          const Icon = VIEW_ICONS[id]
          return (
            <button key={id} type="button" role="tab" aria-selected={view === id}
              className={clsx('tab', view === id && 'tab-active')} onClick={() => onChange(id)}
              onMouseEnter={() => warm(id)} onFocus={() => warm(id)}>
              <Icon size={14} aria-hidden="true" /> {t(`views.${id}`)}
            </button>
          )
        })}
      </div>
    </div>
  )
}

function AgentList({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  const listQuery = useAgentList()
  const { data, isLoading } = listQuery
  const failure = failedReads([listQuery])
  return (
    <>
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
        <ul className="space-y-2">{data.map((agent) => <AgentRow key={agent.agent_id} agent={agent} isAdmin={isAdmin} />)}</ul>
      )}
      <PlansList />
    </>
  )
}

export default function Agents() {
  const { t } = useTranslation('agents')
  const isAdmin = useIsAdmin()
  const [searchParams, setSearchParams] = useSearchParams()
  const view = parseView(searchParams.get('tab'), isAdmin)
  const [creating, setCreating] = useState(false)
  const setView = (next: AgentsView) => setSearchParams((params) => {
    params.set('tab', next)
    return params
  }, { replace: true })
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('list.title')}</h1>
          <p className="text-sm text-muted mt-1 max-w-prose">{t('list.subtitle')}</p>
        </div>
        {isAdmin && view === 'agents' && (
          <button type="button" className="btn btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} aria-hidden="true" /> {t('list.create')}
          </button>
        )}
      </div>
      {isAdmin && <ViewTabs view={view} onChange={setView} />}
      <div role={isAdmin ? 'tabpanel' : undefined} aria-label={isAdmin ? t(`views.${view}`) : undefined} className="space-y-4 sm:space-y-6">
        {view === 'agents' ? <AgentList isAdmin={isAdmin} /> : <WorkflowLibrary />}
      </div>
      {creating && <CreateAgentDialog onClose={() => setCreating(false)} />}
    </div>
  )
}
