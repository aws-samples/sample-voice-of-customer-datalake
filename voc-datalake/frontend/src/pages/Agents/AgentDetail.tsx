/**
 * @fileoverview One automation (`/agents/<id>/<tab>`; 7.52.00 C1, ux-agents-redesign part 2 S6 and part 4 §4.3): its
 * header (Automations/AutomationHeader.tsx: the state chip, "N to fix", its state's one primary and its ⋯ menu), the
 * banner of a run waiting for a person, and its tabs by kind, each a path (agentsPaths.ts), so Back walks them:
 *
 * - an engineering automation: **Runs · Triggers · Settings** (its basics, scope and Instructions as one section)
 *   **· Flow · Budget**;
 * - a product automation: **Runs · Triggers · Settings · Personas · Flow · Budget & models** (its Models with its
 *   budget: both are about cost).
 *
 * `/agents/<id>` opens Runs once it has run, Settings before. The configuration tabs (Triggers, Settings, Personas,
 * Budget) share one draft and one Save bar; Flow is the flow it runs, read only (AgentFlowTab.tsx: Edit in Flows); Runs
 * is its runs, whose Run now is the header's. Admins edit and act; everyone who can see it reads.
 *
 * @module pages/Agents/AgentDetail
 */
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { Gauge, Hand, History, Loader2, Save, Settings2, Users, Workflow, Zap } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { IconTabs } from '../../components/IconTabs/IconTabs'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import { useIsAdmin } from '../../store/authStore'
import { AgentFlowTab } from './AgentFlowTab'
import { PersonasSection } from './AgentPersonas'
import { BudgetSection, InstructionsSection, ModelsSection, SettingsSection } from './AgentSections'
import { TriggersSection } from './AgentTriggers'
import { isEngineeringAgent } from '../../api/agentsApi'
import { RunsTab } from './RunsTab'
import { changedFields, checkUpdate, draftOf, DRAFT_KEYS } from './agentDraft'
import { rebaseDraft } from '../../components/UnsavedChangesGuard/rebaseDraft'
import Notice from '../../components/Notice/Notice'
import { useAgent, useAgentMutations } from './useAgents'
import { useAgentTabPrefetch } from './useAgentTabPrefetch'
import { readTabAddress, useTabPath } from '../../utils/tabPaths'
import { agentIdOf, agentTabPage, agentsPath } from './agentsPaths'
import { AutomationHeader } from './Automations/AutomationHeader'
import { useAutomationHeader } from './Automations/useAutomation'
import type { ComponentType } from 'react'
import type { TFunction } from 'i18next'
import type { Location } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import type { Agent } from '../../api/agentsApi'
import type { AgentDraft } from './agentDraft'
import type { SectionProps } from './AgentSections'

/** Every tab an automation may have; each kind shows its own (TABS_BY_KIND). */
const ALL_TABS = ['runs', 'triggers', 'settings', 'personas', 'flow', 'budget'] as const
type AgentTab = (typeof ALL_TABS)[number]
const CONFIG_TABS: readonly AgentTab[] = ['triggers', 'settings', 'personas', 'budget']

/** Each kind's tabs, in their order (module doc). */
const TABS_BY_KIND: Readonly<Record<'engineering' | 'product', readonly [AgentTab, ...AgentTab[]]>> = {
  engineering: ['runs', 'triggers', 'settings', 'flow', 'budget'],
  product: ['runs', 'triggers', 'settings', 'personas', 'flow', 'budget'],
}

const TAB_ICONS: Readonly<Record<AgentTab, LucideIcon>> = {
  runs: History, triggers: Zap, settings: Settings2, personas: Users, flow: Workflow, budget: Gauge,
}

/** Settings: its basics and scope, and its Instructions, edited together. */
function SettingsTabSection(props: Readonly<SectionProps>) {
  return (
    <div className="space-y-5">
      <SettingsSection {...props} />
      <InstructionsSection {...props} />
    </div>
  )
}

/** Budget (an engineering automation's), or Budget & models (a product one's: its models are about cost too). */
function BudgetTabSection(props: Readonly<SectionProps>) {
  return (
    <div className="space-y-5">
      <BudgetSection {...props} />
      {props.engineering !== true && <ModelsSection {...props} />}
    </div>
  )
}

const SECTIONS: Readonly<Partial<Record<AgentTab, ComponentType<SectionProps>>>> = {
  settings: SettingsTabSection,
  triggers: TriggersSection,
  personas: PersonasSection,
  budget: BudgetTabSection,
}

/** The tab `/agents/<id>` opens: Runs once it has run, Settings before. */
const defaultTab = (agent: Agent): AgentTab => (agent.stats.runs_total > 0 ? 'runs' : 'settings')

/** The tabs of `agent`, `first` first (the one its own path opens). */
function tabPageOf(agent: Agent, first: AgentTab): { readonly shown: readonly AgentTab[]; readonly page: readonly [AgentTab, ...AgentTab[]] } {
  const shown = TABS_BY_KIND[isEngineeringAgent(agent) ? 'engineering' : 'product']
  return { shown, page: [first, ...shown.filter((tab) => tab !== first)] }
}

/** Unsaved config edits survive a switch between config tabs, not a move anywhere else. */
function leavesConfigTabs(current: Location, next: Location): boolean {
  const read = readTabAddress(agentTabPage(agentIdOf(current.pathname) ?? '', ALL_TABS), next)
  return read === null || !CONFIG_TABS.includes(read.place)
}

/**
 * The shared unsaved-changes guard over the config draft (E2E F6). Only an
 * admin's edits are guarded; Save is off while the draft has errors.
 */
function useConfigGuard({ isAdmin, dirty, checked, save, discard }: Readonly<{
  isAdmin: boolean
  dirty: boolean
  checked: ReturnType<typeof checkUpdate>
  save: (body: Parameters<ReturnType<typeof useAgentMutations>['update']['mutateAsync']>[0]) => Promise<unknown>
  discard: () => void
}>) {
  const body = 'body' in checked ? checked.body : undefined
  return useUnsavedChangesGuard({
    dirty: isAdmin && dirty,
    canSave: body !== undefined,
    onSave: async () => {
      if (body === undefined) return false
      await save(body)
      return true
    },
    onDiscard: discard,
    // The config tabs share this draft; only leaving them loses it.
    shouldBlock: leavesConfigTabs,
  })
}

function ConfigEditor({ agent, tab, isAdmin }: Readonly<{ agent: Agent; tab: AgentTab; isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  const { update } = useAgentMutations(agent.agent_id)
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(agent))
  const [base, setBase] = useState(agent)
  if (base !== agent) {
    // A fresh server copy (after a save, a refetch, a run's stats update)
    // re-bases the draft: untouched fields follow it, edited ones are kept (R2).
    setBase(agent)
    setDraft(rebaseDraft(draftOf(base), draftOf(agent), draft, DRAFT_KEYS))
  }
  const changes = changedFields(agent, draft)
  const dirty = Object.keys(changes).length > 0
  const engineering = isEngineeringAgent(agent)
  const checked = checkUpdate(changes, engineering)
  const Section = SECTIONS[tab]
  const guard = useConfigGuard({ isAdmin, dirty, checked, save: update.mutateAsync, discard: () => setDraft(draftOf(agent)) })
  return (
    <div className="space-y-4">
      <div className="card">
        {Section !== undefined && <Section draft={draft} readOnly={!isAdmin} onChange={setDraft} engineering={engineering} />}
      </div>
      {isAdmin && (
        <StickyActionBar>
          {'errors' in checked && dirty && (
            <ul role="alert" className="mr-auto text-[12px] text-danger">{checked.errors.map((e) => <li key={e.key}>{t(e.key, e.values)}</li>)}</ul>
          )}
          {update.isError && <p role="alert" className="mr-auto text-[12px] text-danger">{t('detail.saveFailed')}</p>}
          {update.isSuccess && !dirty && <p role="status" className="mr-auto text-[12px] text-muted">{t('detail.saved')}</p>}
          <span className="ml-auto" />
          <button type="button" className="btn btn-secondary btn-sm" disabled={!dirty} onClick={() => setDraft(draftOf(agent))}>
            {t('detail.discard')}
          </button>
          <button type="button" className="btn btn-primary btn-sm" disabled={!dirty || 'errors' in checked || update.isPending}
            onClick={() => { if ('body' in checked) update.mutate(checked.body) }}>
            {update.isPending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : <Save size={14} aria-hidden="true" />}
            {t('detail.save')}
          </button>
        </StickyActionBar>
      )}
      {guard.dialog}
    </div>
  )
}

/** The automation's last run waits for a person: one line and a way to the run. */
function NeedsDecisionBanner({ onReview }: Readonly<{ onReview: () => void }>) {
  const { t } = useTranslation('agents')
  return (
    <Notice variant="banner" tone="warn" role="status" icon={Hand} text={t('decision.banner')}
      action={{ label: t('decision.reviewRun'), onClick: onReview }} />
  )
}

/** A tab's label: Flow, Budget & models (a product automation's), else its own. */
function tabLabel(tab: AgentTab, engineering: boolean, t: TFunction<'agents'>): string {
  if (tab === 'flow') return t('detail.tab.flow')
  if (tab === 'budget' && !engineering) return t('detail.tab.budgetModels')
  return t(`tabs.${tab}`)
}

/** The page of a loaded automation: its header, the banner, its tabs and the open tab. */
function AgentPage({ agent, isAdmin }: Readonly<{ agent: Agent; isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  // (decided as the page opens: a first run ending while it is open never moves an unsaved draft off its tab)
  const [first] = useState(() => defaultTab(agent))
  const { shown, page } = tabPageOf(agent, first)
  const [tab, setTab] = useTabPath(agentTabPage(agent.agent_id, page))
  const prefetchTab = useAgentTabPrefetch(agent, isAdmin)
  const header = useAutomationHeader(agent, isAdmin)
  const engineering = isEngineeringAgent(agent)
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0">
      <AutomationHeader agent={agent} isAdmin={isAdmin} header={header} />
      {agent.stats.last_run_status === 'needs_human' && tab !== 'runs' && <NeedsDecisionBanner onReview={() => setTab('runs')} />}
      <IconTabs tabs={shown} active={tab} icons={TAB_ICONS} label={t('detail.tabs')} labelOf={(id) => tabLabel(id, engineering, t)}
        onSelect={setTab} onWarm={prefetchTab} />
      <div role="tabpanel" aria-label={tabLabel(tab, engineering, t)}>
        {CONFIG_TABS.includes(tab) && <ConfigEditor agent={agent} tab={tab} isAdmin={isAdmin} />}
        {tab === 'flow' && <AgentFlowTab agent={agent} isAdmin={isAdmin} />}
        {tab === 'runs' && <RunsTab agent={agent} isAdmin={isAdmin} onRunNow={header.actions.runNow} />}
      </div>
    </div>
  )
}

export default function AgentDetail() {
  const { t } = useTranslation('agents')
  // The route is `agents/:id` (routes.tsx, pageContext.ts, Breadcrumbs).
  const { id: agentId = '' } = useParams()
  const isAdmin = useIsAdmin()
  const { data: agent, isLoading, isError } = useAgent(agentId)
  if (isLoading) return <div className="skeleton h-40" />
  if (isError || agent === undefined) {
    return (
      <div className="card space-y-2">
        <p className="text-sm text-danger">{t('detail.notFound')}</p>
        <Link to={agentsPath({ view: 'agents' })} className="text-sm link">{t('detail.backToAutomations')}</Link>
      </div>
    )
  }
  return <AgentPage agent={agent} isAdmin={isAdmin} />
}
