/**
 * @fileoverview Autonomous agents — the list: each agent's state, scope, last
 * run and spend; admins create agents here (created DISABLED, like the
 * assistant's `create_agent`). Admins also get a Workflows tab (`/agents/workflows`):
 * the workflow library; and, when the engineering agents are on, a Spend tab
 * (`/agents/spend`): what they spent, from the spend ledger, a Connections tab
 * (`/agents/connections`): the repository connections they reach a repository through, and a Skills tab
 * (`/agents/skills`): their skill versions' history and scorecards, read only. Each view is a path
 * (agentsPaths.ts), so Back walks them. With the engineering agents on, an administrator also gets **Setup guide**
 * (`/agents/setup`, SetupGuide/), offered on a first visit while nothing is set up (7.50.00).
 *
 * @module pages/Agents/Agents
 */
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { Bot, CircleDollarSign, GraduationCap, Hand, KeyRound, Plus, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { NameDialog } from '../../components/NameDialog/NameDialog'
import { failedReads } from '../../utils/failedReads'
import { API_AGENT_LIMITS, isEngineeringAgent } from '../../api/agentsApi'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { useIsAdmin } from '../../store/authStore'
import { isEngineeringAvailable } from '../../runtimeConfig'
import { RunStatusBadge, ScopeSummary } from './AgentBadges'
import { useAgentList, useCreateAgent } from './useAgents'
import { WorkflowLibrary } from './WorkflowLibrary'
import { EngineeringSpend } from './EngineeringSpend'
import { EngineeringConnections } from './EngineeringConnections'
import { EngineeringSkills } from './EngineeringSkills'
import { AgentRowActions } from './AgentRowActions'
import { EngineeringSetUpCard } from './AgentEngineering'
import { PlansList } from './PlansList'
import { SetupGuideButton, SetupIntro } from './SetupGuide/SetupGuideEntry'
import { prefetch } from '../../lib/prefetch'
import { usePlaceNavigate, useReplaceAddress } from '../../utils/pathPlace'
import { AGENTS_VIEWS, agentPath, agentsPath, readAgentsAddress } from './agentsPaths'
import type { AgentsView } from './agentsPaths'
import type { LucideIcon } from 'lucide-react'
import type { Agent } from '../../api/agentsApi'

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
      {/* An engineering agent not set up yet: its Set up (or Connect a repository first), as on its page. */}
      {isAdmin && isEngineeringAgent(agent) && <div className="ml-4"><EngineeringSetUpCard agent={agent} /></div>}
      {/* Beside the row, not inside it: a link cannot hold another link. */}
      {needsDecision && (
        <Link to={agentPath(agent.agent_id, 'runs')} className="ml-4 inline-flex items-center gap-1 text-[12px] link">
          <Hand size={13} aria-hidden="true" /> {t('list.reviewRun', { name: agent.name })}
        </Link>
      )}
    </li>
  )
}

const VIEW_ICONS: Readonly<Record<AgentsView, LucideIcon>> = {
  agents: Bot, workflows: Workflow, spend: CircleDollarSign, connections: KeyRound, skills: GraduationCap,
}
/** The engineering agents' views: their reads answer 404 while the module is off. */
const ENGINEERING_VIEWS: ReadonlySet<AgentsView> = new Set(['spend', 'connections', 'skills'])

/** The views an admin has: Spend, Connections and Skills only while the engineering agents are on. */
const adminViews = (): readonly AgentsView[] => (isEngineeringAvailable() ? AGENTS_VIEWS : AGENTS_VIEWS.filter((id) => !ENGINEERING_VIEWS.has(id)))

/** The path picks the view (`/agents/workflows`, agentsPaths.ts); only admins have the library and the spend. */
function parseView(value: AgentsView, isAdmin: boolean): AgentsView {
  const view = adminViews().find((id) => id === value)
  return isAdmin && view !== undefined ? view : 'agents'
}

function ViewTabs({ view, onChange }: Readonly<{ view: AgentsView; onChange: (view: AgentsView) => void }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  // The library's list is read before the tab opens, so the first switch renders from cache.
  const warm = (id: AgentsView) => {
    if (id === 'workflows') void prefetch(queryClient, { queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, staleTime: 30_000 })
  }
  return (
    <IconTabs tabs={adminViews()} active={view} icons={VIEW_ICONS} label={t('views.label')} labelOf={(id) => t(`views.${id}`)}
      onSelect={onChange} onWarm={warm} />
  )
}

function AgentList({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  const listQuery = useAgentList()
  const { data, isLoading } = listQuery
  const failure = failedReads([listQuery])
  return (
    <>
      {isAdmin && isEngineeringAvailable() && <SetupIntro agents={data} />}
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

/** The view the path names (a path off its form replaced by the view's own), and the move to another (a history entry). */
function useAgentsView(isAdmin: boolean): readonly [AgentsView, (view: AgentsView) => void] {
  const read = readAgentsAddress(useLocation())
  useReplaceAddress(read?.replaceWith ?? null)
  const move = usePlaceNavigate()
  // A new view starts from its own options: the Spend tab's month, grouping and workflow go with it.
  const setView = (next: AgentsView) => { move({ pathname: agentsPath({ view: next }), search: '' }) }
  return [parseView(read?.place.view ?? 'agents', isAdmin), setView]
}

/** The list's own actions (an admin's): the setup guide, with the engineering agents on, and New agent. */
function ListActions({ onCreate }: Readonly<{ onCreate: () => void }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="flex flex-wrap gap-2">
      {isEngineeringAvailable() && <SetupGuideButton />}
      <button type="button" className="btn btn-primary" onClick={onCreate}>
        <Plus size={16} aria-hidden="true" /> {t('list.create')}
      </button>
    </div>
  )
}

export default function Agents() {
  const { t } = useTranslation('agents')
  const isAdmin = useIsAdmin()
  const [view, setView] = useAgentsView(isAdmin)
  const [creating, setCreating] = useState(false)
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('list.title')}</h1>
          <p className="text-sm text-muted mt-1 max-w-prose">{t('list.subtitle')}</p>
        </div>
        {isAdmin && view === 'agents' && <ListActions onCreate={() => setCreating(true)} />}
      </div>
      {isAdmin && <ViewTabs view={view} onChange={setView} />}
      <div role={isAdmin ? 'tabpanel' : undefined} aria-label={isAdmin ? t(`views.${view}`) : undefined} className="space-y-4 sm:space-y-6">
        {view === 'agents' && <AgentList isAdmin={isAdmin} />}
        {view === 'workflows' && <WorkflowLibrary />}
        {view === 'spend' && <EngineeringSpend />}
        {view === 'connections' && <EngineeringConnections />}
        {view === 'skills' && <EngineeringSkills />}
      </div>
      {creating && <CreateAgentDialog onClose={() => setCreating(false)} />}
    </div>
  )
}
