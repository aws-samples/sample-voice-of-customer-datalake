/**
 * @fileoverview One autonomous agent: configuration tabs (Settings, Triggers,
 * Personas, Instructions, Models, Budget) sharing one draft and one Save bar,
 * the Workflow editor, and the Runs tab. `?tab=` deep-links a tab. Admins
 * edit, enable/disable, archive and run; everyone who can see the agent reads.
 *
 * @module pages/Agents/AgentDetail
 */
import { useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Archive, ArrowLeft, Bot, Gauge, History, Loader2, MessageSquareText, Save, Settings2, Sparkles, Users, Workflow, Zap,
} from 'lucide-react'
import clsx from 'clsx'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import { WorkflowEditor } from '../../components/WorkflowEditor/WorkflowEditor'
import { DEFAULT_WORKFLOW_ID } from '../../api/workflowsApi'
import { useIsAdmin } from '../../store/authStore'
import { ScopeSummary } from './AgentBadges'
import { PersonasSection } from './AgentPersonas'
import { BudgetSection, InstructionsSection, ModelsSection, SettingsSection } from './AgentSections'
import { TriggersSection } from './AgentTriggers'
import { RunsTab } from './RunsTab'
import { changedFields, checkUpdate, draftOf, DRAFT_KEYS } from './agentDraft'
import { rebaseDraft } from '../../components/UnsavedChangesGuard/rebaseDraft'
import { useAgent, useAgentMutations } from './useAgents'
import type { ComponentType } from 'react'
import type { Location } from 'react-router-dom'
import type { LucideIcon } from 'lucide-react'
import type { Agent } from '../../api/agentsApi'
import type { AgentDraft } from './agentDraft'
import type { SectionProps } from './AgentSections'

const TABS = ['settings', 'triggers', 'personas', 'instructions', 'models', 'budget', 'workflow', 'runs'] as const
type AgentTab = (typeof TABS)[number]
const CONFIG_TABS: readonly AgentTab[] = ['settings', 'triggers', 'personas', 'instructions', 'models', 'budget']

const TAB_ICONS: Readonly<Record<AgentTab, LucideIcon>> = {
  settings: Settings2, triggers: Zap, personas: Users, instructions: MessageSquareText,
  models: Sparkles, budget: Gauge, workflow: Workflow, runs: History,
}

const SECTIONS: Readonly<Partial<Record<AgentTab, ComponentType<SectionProps>>>> = {
  settings: SettingsSection,
  triggers: TriggersSection,
  personas: PersonasSection,
  instructions: InstructionsSection,
  models: ModelsSection,
  budget: BudgetSection,
}

const parseTab = (value: string | null): AgentTab => TABS.find((tab) => tab === value) ?? 'settings'

/** Unsaved config edits survive a switch between config tabs, not a move anywhere else. */
function leavesConfigTabs(current: Location, next: Location): boolean {
  if (current.pathname !== next.pathname) return true
  return !CONFIG_TABS.includes(parseTab(new URLSearchParams(next.search).get('tab')))
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
    // The six config tabs share this draft; only leaving them loses it.
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
  const checked = checkUpdate(changes)
  const Section = SECTIONS[tab]
  const guard = useConfigGuard({ isAdmin, dirty, checked, save: update.mutateAsync, discard: () => setDraft(draftOf(agent)) })
  return (
    <div className="space-y-4">
      <div className="card">
        {Section !== undefined && <Section draft={draft} readOnly={!isAdmin} onChange={setDraft} />}
      </div>
      {isAdmin && (
        <StickyActionBar>
          {'errors' in checked && dirty && (
            <ul role="alert" className="mr-auto text-[12px] text-danger">{checked.errors.map((e) => <li key={e}>{e}</li>)}</ul>
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

function Header({ agent, isAdmin }: Readonly<{ agent: Agent; isAdmin: boolean }>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const { setEnabled, archive } = useAgentMutations(agent.agent_id)
  const [confirmArchive, setConfirmArchive] = useState(false)
  return (
    <div className="flex flex-wrap items-start gap-3">
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-accent-subtle text-accent-text">
        <Bot size={20} aria-hidden="true" />
      </span>
      <div className="mr-auto min-w-0">
        <h1 className="text-2xl font-bold tracking-tight text-text-strong truncate">{agent.name}</h1>
        <p className="text-sm text-muted mt-1"><ScopeSummary scope={agent.scope} /></p>
        <p className="text-[12px] text-muted font-mono mt-0.5">
          {t('detail.stats', {
            runs: agent.stats.runs_total, today: agent.stats.scheduled_runs_today, calls: agent.stats.model_calls_this_month,
          })}
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm text-text">
        <button type="button" role="switch" aria-checked={agent.enabled} disabled={!isAdmin || setEnabled.isPending}
          className={clsx('switch', agent.enabled && 'switch-on')} onClick={() => setEnabled.mutate(!agent.enabled)}
          aria-label={t('detail.enabledLabel')}>
          <span className="switch-knob" />
        </button>
        {agent.enabled ? t('status.enabled') : t('status.disabled')}
      </label>
      {isAdmin && (
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setConfirmArchive(true)}>
          <Archive size={14} aria-hidden="true" /> {t('detail.archive')}
        </button>
      )}
      {setEnabled.isError && <p role="alert" className="w-full text-[12px] text-danger">{t('detail.toggleFailed')}</p>}
      <ConfirmModal
        isOpen={confirmArchive}
        title={t('detail.archiveTitle')}
        message={t('detail.archiveMessage')}
        confirmLabel={t('detail.archive')}
        cancelLabel={t('common.cancel')}
        variant="warning"
        isLoading={archive.isPending}
        onConfirm={() => archive.mutate(undefined, { onSuccess: () => { void navigate('/agents') } })}
        onCancel={() => setConfirmArchive(false)}
      />
    </div>
  )
}

export default function AgentDetail() {
  const { t } = useTranslation('agents')
  // The route is `agents/:id` (routes.tsx, pageContext.ts, Breadcrumbs).
  const { id: agentId = '' } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = parseTab(searchParams.get('tab'))
  const isAdmin = useIsAdmin()
  const { data: agent, isLoading, isError } = useAgent(agentId)
  const { update } = useAgentMutations(agentId)
  const setTab = (next: AgentTab) => setSearchParams((params) => {
    params.set('tab', next)
    return params
  }, { replace: true })

  if (isLoading) return <div className="skeleton h-40" />
  if (isError || agent === undefined) {
    return (
      <div className="card space-y-2">
        <p className="text-sm text-danger">{t('detail.notFound')}</p>
        <Link to="/agents" className="text-sm link">{t('detail.back')}</Link>
      </div>
    )
  }
  return (
    <div className="space-y-4 sm:space-y-6 min-w-0">
      <Link to="/agents" className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} aria-hidden="true" /> {t('detail.back')}
      </Link>
      <Header agent={agent} isAdmin={isAdmin} />
      <div className="tabs-rail overflow-x-auto">
        <div className="tabs-track" role="tablist" aria-label={t('detail.tabs')}>
          {TABS.map((id) => {
            const Icon = TAB_ICONS[id]
            return (
              <button key={id} type="button" role="tab" aria-selected={tab === id}
                className={clsx('tab', tab === id && 'tab-active')} onClick={() => setTab(id)}>
                <Icon size={14} aria-hidden="true" /> {t(`tabs.${id}`)}
              </button>
            )
          })}
        </div>
      </div>
      <div role="tabpanel" aria-label={t(`tabs.${tab}`)}>
        {CONFIG_TABS.includes(tab) && <ConfigEditor agent={agent} tab={tab} isAdmin={isAdmin} />}
        {tab === 'workflow' && (
          <WorkflowEditor
            workflowId={agent.workflow_id ?? DEFAULT_WORKFLOW_ID}
            canEdit={isAdmin}
            onSavedAs={(workflow) => update.mutate({ workflow_id: workflow.workflow_id })}
          />
        )}
        {tab === 'runs' && <RunsTab agent={agent} isAdmin={isAdmin} />}
      </div>
    </div>
  )
}
