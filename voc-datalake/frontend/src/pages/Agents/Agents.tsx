/**
 * @fileoverview Agent orchestration (`/agents`; 7.52.00 C1, ux-agents-redesign parts 1 and 4, the roadmap's owner
 * decisions of 2026-11-17): the shell of its tabs, a layout route (routes.tsx) whose tabs are its child routes.
 *
 * - **The header:** the title, one line of what it is, and (an administrator's, on Automations) **Setup guide · N of M
 *   done** with the engineering agents on, and **New automation** (a product automation, created off).
 * - **The tabs, in their order** (operate, then build, then the set-up-once plumbing): Automations `/agents` ·
 *   Runs `/agents/runs` (with the runs waiting for a person) · Skills `/agents/skills` (with the versions waiting for
 *   review) · Spend `/agents/spend` · Flows `/agents/workflows` · Registry `/agents/registry` (Quality gates is its
 *   filter, C3's) · Connections `/agents/connections`. Each is a path (agentsPaths.ts), so Back walks them; a tab
 *   switch starts the next tab from its own options (the query is dropped). Runs, Skills, Spend, Registry and
 *   Connections are the engineering agents', shown only while they are on.
 * - **The content** is the child route's (`<Outlet />`): Automations (Automations/AutomationsView.tsx), Runs
 *   (RunWorkspace/RunsView.tsx), Spend, Flows (WorkflowLibrary.tsx), Connections, and the Skills and Registry pages
 *   of `orchestrationRoutes.registry.tsx` (C3's). A path of a tab this person may not see shows Automations.
 *
 * A person who is not an administrator gets no tab row and no buttons: Automations, read only.
 *
 * @module pages/Agents/Agents
 */
import { Suspense, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { Bot, Boxes, CircleDollarSign, GraduationCap, History, KeyRound, Plus, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import { NameDialog } from '../../components/NameDialog/NameDialog'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import { API_AGENT_LIMITS } from '../../api/agentsApi'
import { workflowsApi, workflowsKeys } from '../../api/workflowsApi'
import { useIsAdmin } from '../../store/authStore'
import { isEngineeringAvailable } from '../../runtimeConfig'
import { useCreateAgent } from './useAgents'
import { AutomationsView } from './Automations/AutomationsView'
import { EngineeringConnections } from './EngineeringConnections'
import { EngineeringSpend } from './EngineeringSpend'
import { PlansList } from './PlansList'
import { RunsView } from './RunWorkspace/RunsView'
import { WorkflowLibrary } from './WorkflowLibrary'
import { SetupGuideButton } from './SetupGuide/SetupGuideEntry'
import { prefetch } from '../../lib/prefetch'
import { usePlaceNavigate, useReplaceAddress } from '../../utils/pathPlace'
import { AGENTS_VIEWS, agentPath, agentsPath, readAgentsAddress } from './agentsPaths'
import { useRunsNeedingYou, useSkillsToReview } from './orchestrationCounts'
import type { AgentsView } from './agentsPaths'
import type { LucideIcon } from 'lucide-react'

const VIEW_ICONS: Readonly<Record<AgentsView, LucideIcon>> = {
  agents: Bot, runs: History, skills: GraduationCap, spend: CircleDollarSign, workflows: Workflow, registry: Boxes,
  connections: KeyRound,
}
/** The engineering agents' tabs: their reads answer 404 while the module is off. */
const ENGINEERING_VIEWS: ReadonlySet<AgentsView> = new Set(['runs', 'skills', 'spend', 'registry', 'connections'])
/** The tabs whose pages read (and replace) their own places: C3's Skills and Registry. */
const OWN_PLACE_VIEWS: ReadonlySet<AgentsView> = new Set(['skills', 'registry'])

/** The tabs an administrator has: the engineering ones only while the engineering agents are on. */
const adminViews = (): readonly AgentsView[] => (isEngineeringAvailable() ? AGENTS_VIEWS : AGENTS_VIEWS.filter((id) => !ENGINEERING_VIEWS.has(id)))

/** The tab a path names, if this person may see it (else Automations). */
function parseView(value: AgentsView, isAdmin: boolean): AgentsView {
  const view = adminViews().find((id) => id === value)
  return isAdmin && view !== undefined ? view : 'agents'
}

function CreateAutomationDialog({ onClose }: Readonly<{ onClose: () => void }>) {
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
    <NameDialog title={t('shell.createTitle')} hint={t('list.createHint')} submitLabel={t('shell.createSubmit')} initialName=""
      label={t('fields.name')} maxLength={API_AGENT_LIMITS.maxNameChars}
      description={{ label: t('fields.description'), maxLength: API_AGENT_LIMITS.maxDescriptionChars }}
      saving={create.isPending} error={create.isError ? t('list.createFailed') : undefined}
      onSave={submit} onClose={onClose} />
  )
}

/** A tab's label, with its count when something waits ("Runs (2)", named "Runs (2 need you)"). */
function TabLabel({ id, counts }: Readonly<{ id: AgentsView; counts: Readonly<Partial<Record<AgentsView, number | null>>> }>) {
  const { t } = useTranslation('agents')
  const count = counts[id] ?? null
  return (
    <>
      {t(`shell.tabs.${id}`)}
      {count !== null && count > 0 && (
        <>
          <span className="font-mono" aria-hidden="true">({count})</span>
          {' '}<span className="sr-only">({t(`shell.counts.${id}`, { count })})</span>
        </>
      )}
    </>
  )
}

function ViewTabs({ view, isAdmin, onChange }: Readonly<{ view: AgentsView; isAdmin: boolean; onChange: (view: AgentsView) => void }>) {
  const { t } = useTranslation('agents')
  const queryClient = useQueryClient()
  const runs = useRunsNeedingYou(isAdmin)
  const skills = useSkillsToReview(isAdmin)
  const counts = { runs, skills: skills === null ? null : skills.length }
  // The library's list is read before the tab opens, so the first switch renders from cache.
  const warm = (id: AgentsView) => {
    if (id === 'workflows') void prefetch(queryClient, { queryKey: workflowsKeys.list(), queryFn: workflowsApi.list, staleTime: 30_000 })
  }
  return (
    <IconTabs tabs={adminViews()} active={view} icons={VIEW_ICONS} label={t('shell.tabs.label')}
      labelOf={(id) => <TabLabel id={id} counts={counts} />} onSelect={onChange} onWarm={warm} />
  )
}

/**
 * The tab the path names (a path off its form replaced by the tab's own, except on the tabs whose pages read their
 * own places), the tab shown (Automations for one this person may not see), and the move to another (a history entry).
 */
function useAgentsView(isAdmin: boolean): { readonly named: AgentsView; readonly view: AgentsView; readonly setView: (view: AgentsView) => void } {
  const read = readAgentsAddress(useLocation())
  const named = read?.place.view ?? 'agents'
  const view = parseView(named, isAdmin)
  useReplaceAddress(view === named && !OWN_PLACE_VIEWS.has(view) ? read?.replaceWith ?? null : null)
  const move = usePlaceNavigate()
  // A new tab starts from its own options: the Spend tab's month, grouping and flow go with it.
  const setView = (next: AgentsView) => { move({ pathname: agentsPath({ view: next }), search: '' }) }
  return { named, view, setView }
}

/** The header's own actions (an administrator's, on Automations): the setup guide and New automation. */
function ListActions({ onCreate }: Readonly<{ onCreate: () => void }>) {
  const { t } = useTranslation('agents')
  return (
    <div className="flex flex-wrap gap-2">
      {isEngineeringAvailable() && <SetupGuideButton />}
      <button type="button" className="btn btn-primary" onClick={onCreate}>
        <Plus size={16} aria-hidden="true" /> {t('shell.create')}
      </button>
    </div>
  )
}

export default function Agents() {
  const { t } = useTranslation('agents')
  const isAdmin = useIsAdmin()
  const { named, view, setView } = useAgentsView(isAdmin)
  const [creating, setCreating] = useState(false)
  // (a tab this person may not see: Automations in its place, not the route's page)
  const content = view === named ? <Outlet /> : <AutomationsTab />
  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <PageTitle title={t('shell.title')} subtitle={t('shell.subtitle')} />
        </div>
        {isAdmin && view === 'agents' && <ListActions onCreate={() => setCreating(true)} />}
      </div>
      {isAdmin && <ViewTabs view={view} isAdmin={isAdmin} onChange={setView} />}
      <div role={isAdmin ? 'tabpanel' : undefined} aria-label={isAdmin ? t(`shell.tabs.${view}`) : undefined} className="space-y-4 sm:space-y-6">
        <Suspense fallback={<div className="skeleton h-24" />}>{content}</Suspense>
      </div>
      {creating && <CreateAutomationDialog onClose={() => setCreating(false)} />}
    </div>
  )
}

/** Whether this person has the Runs tab (an administrator, with the engineering agents on), where their plans are. */
const hasRunsTab = (isAdmin: boolean): boolean => isAdmin && isEngineeringAvailable()

/**
 * Automations, the shell's index route: the list, whose empty state offers New automation. The caller's assistant
 * plans stay under it for whoever has no Runs tab (ux-agents-redesign G7: they move to Runs).
 */
export function AutomationsTab() {
  const isAdmin = useIsAdmin()
  const [creating, setCreating] = useState(false)
  return (
    <>
      <AutomationsView isAdmin={isAdmin} onCreate={() => setCreating(true)} />
      {!hasRunsTab(isAdmin) && <PlansList />}
      {creating && <CreateAutomationDialog onClose={() => setCreating(false)} />}
    </>
  )
}

/** Runs: the engineering runs (7.51.00's list, its filters in the query), then the caller's assistant plans (G7). */
export function RunsTabPage() {
  return (
    <>
      <RunsView />
      <PlansList />
    </>
  )
}

/** Spend, Flows and Connections: the tabs' own pages. */
export function SpendTab() {
  return <EngineeringSpend />
}

export function FlowsTab() {
  return <WorkflowLibrary />
}

export function ConnectionsTab() {
  return <EngineeringConnections />
}
