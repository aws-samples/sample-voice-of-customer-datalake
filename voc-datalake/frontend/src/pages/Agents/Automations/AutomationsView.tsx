/**
 * @fileoverview Agent orchestration → Automations (`/agents`; 7.52.00 C1, ux-agents-redesign part 1 §2.3, part 4 §4.4):
 * "Needs you" first (what waits for a person), then the automations in two groups, each a `<section>` with its
 * heading and one line of what it does, rows in the server's order (the loop's: triage → bug → feature):
 *
 * - **Engineering automations** first, for an administrator with the engineering agents on (where action is needed):
 *   its card holds the first-run prompt (SetupGuideEntry.tsx) or, while none of them has a GitHub connection it can
 *   use, one banner that says so once with **Connect GitHub**;
 * - **Product automations**.
 *
 * Each row is AutomationRow.tsx. With no automation at all, one empty state with **New automation** (an
 * administrator's). A failed read says so and offers to read again.
 *
 * @module pages/Agents/Automations/AutomationsView
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Bot, KeyRound, Plus } from 'lucide-react'
import LoadFailed from '../../../components/LoadFailed/LoadFailed'
import Notice from '../../../components/Notice/Notice'
import { failedReads } from '../../../utils/failedReads'
import { isEngineeringAvailable } from '../../../runtimeConfig'
import { agentsPath } from '../agentsPaths'
import { usableConnections } from '../engineeringAgentRules'
import { useAgentList } from '../useAgents'
import { SetupPrompt } from '../SetupGuide/SetupGuideEntry'
import { useOffersSetupPrompt } from '../SetupGuide/useSetupGuide'
import { groupAutomations } from './automationState'
import { AutomationRow, ROW_GRID } from './AutomationRow'
import { NeedsYou } from './NeedsYou'
import { useAutomationFacts } from './useAutomationFacts'
import type { ReactNode } from 'react'
import type { Agent } from '../../../api/agentsApi'
import type { AutomationFacts } from './useAutomationFacts'

/** The list's column header (`aria-hidden`: each cell carries its own sr-only name). */
function ColumnHeader() {
  const { t } = useTranslation('agents')
  return (
    <div aria-hidden="true"
      className={clsx('hidden bg-bg-accent px-4 py-2 text-[11px] font-semibold uppercase tracking-[.04em] text-muted-strong', ROW_GRID)}>
      <span>{t('automations.columns.automation')}</span>
      <span>{t('automations.columns.status')}</span>
      <span>{t('automations.columns.lastRun')}</span>
      <span>{t('automations.columns.usage')}</span>
      <span />
    </div>
  )
}

function AutomationGroup({ kind, agents, isAdmin, facts, lead }: Readonly<{
  kind: 'engineering' | 'product'; agents: readonly Agent[]; isAdmin: boolean; facts: AutomationFacts; lead?: ReactNode
}>) {
  const { t } = useTranslation('agents')
  const titleId = useId()
  if (agents.length === 0) return null
  return (
    <section aria-labelledby={titleId} className="space-y-2" data-testid={`group-${kind}`}>
      <div>
        <h2 id={titleId} className="text-sm font-semibold tracking-tight text-text-strong">{t(`automations.groups.${kind}.title`)}</h2>
        <p className="text-[12px] text-muted max-w-prose">{t(`automations.groups.${kind}.hint`)}</p>
      </div>
      <div className="card p-0 overflow-hidden">
        {lead}
        <ColumnHeader />
        <ul role="list" className="divide-y divide-border">
          {agents.map((agent) => <AutomationRow key={agent.agent_id} agent={agent} isAdmin={isAdmin} facts={facts} />)}
        </ul>
      </div>
    </section>
  )
}

/** The Engineering group's one blocker: none of its automations that is off has a connection it can use. */
function needsConnection(agents: readonly Agent[], facts: AutomationFacts): boolean {
  const { connections } = facts
  if (connections === undefined) return false
  return agents.some((agent) => !agent.enabled && usableConnections(agent, connections).length === 0)
}

/** What heads the Engineering group's card: the first-run prompt, else the blocker banner, else nothing. */
function EngineeringLead({ agents, all, facts }: Readonly<{ agents: readonly Agent[]; all: readonly Agent[]; facts: AutomationFacts }>) {
  const { t } = useTranslation('agents')
  const prompt = useOffersSetupPrompt(all)
  if (prompt !== null) return <SetupPrompt progress={prompt} />
  if (!needsConnection(agents, facts)) return null
  return (
    <div className="border-b border-border p-3">
      <Notice variant="banner" tone="warn" role="note" icon={KeyRound} text={t('automations.blocked.noConnection')}
        action={{ label: t('automations.blocked.connect'), to: agentsPath({ view: 'connections' }) }} />
    </div>
  )
}

export function AutomationsView({ isAdmin, onCreate }: Readonly<{ isAdmin: boolean; onCreate: () => void }>) {
  const { t } = useTranslation('agents')
  const listQuery = useAgentList()
  const facts = useAutomationFacts(isAdmin)
  const { data, isLoading } = listQuery
  const failure = failedReads([listQuery])
  const groups = groupAutomations(data ?? [])
  const engineeringOn = isAdmin && isEngineeringAvailable()
  return (
    <div className="space-y-4 sm:space-y-6">
      {isLoading && <div className="skeleton h-24" />}
      {failure.loadFailed && <LoadFailed message={t('list.loadFailed')} onRetry={failure.retry} retrying={failure.retrying} />}
      {data?.length === 0 && (
        <Notice variant="empty" icon={Bot} title={t('list.emptyTitle')} text={isAdmin ? t('list.emptyAdmin') : t('list.emptyUser')}
          action={isAdmin ? { label: t('shell.create'), icon: Plus, emphasis: 'primary', onClick: onCreate } : undefined} />
      )}
      {data !== undefined && data.length > 0 && (
        <>
          <NeedsYou agents={data} isAdmin={isAdmin} />
          <AutomationGroup kind="engineering" agents={groups.engineering} isAdmin={isAdmin} facts={facts}
            lead={engineeringOn ? <EngineeringLead agents={groups.engineering} all={data} facts={facts} /> : undefined} />
          <AutomationGroup kind="product" agents={groups.product} isAdmin={isAdmin} facts={facts} />
        </>
      )}
    </div>
  )
}
