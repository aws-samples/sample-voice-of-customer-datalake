/**
 * @fileoverview An automation's page header (`/agents/<id>`; 7.52.00 C1, ux-agents-redesign part 2 S6): "← Automations",
 * its tile, its name and what it does, one meta line ("Acts as admin, who enabled it · Deployment feedback · 12 runs ·
 * 3 today" for an engineering automation; its scope, its runs and its model calls for a product one, in the body font),
 * then its state chip with the one line under it ("▲ 2 to fix", a reason), its state's one primary (`btn-primary`:
 * the page's one) and its ⋯ menu (Pause or Resume, Turn off, Run now, Change setup…, Rename…, Archive…). The state,
 * the primary and the menu are the Automations list's (automationState.ts, useAutomationActions.tsx). A person who is
 * not an administrator gets the chip and no action.
 *
 * @module pages/Agents/Automations/AutomationHeader
 */
import { useId } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { ArrowLeft } from 'lucide-react'
import { RowActionsMenu } from '../../../components/RowActionsMenu/RowActionsMenu'
import { isEngineeringAgent } from '../../../api/agentsApi'
import { formatCount } from '../../../utils/numberFormat'
import { agentsPath } from '../agentsPaths'
import { ScopeSummary } from '../AgentBadges'
import { AutomationStateChip, AutomationTileIcon, StateReason } from './AutomationCells'
import { PrimaryButton } from './AutomationRow'
import { pageMenuEntries } from './automationMenu'
import type { Agent } from '../../../api/agentsApi'
import type { AutomationView } from './useAutomation'

/** The meta line (module doc). */
function MetaLine({ agent }: Readonly<{ agent: Agent }>) {
  const { t, i18n } = useTranslation('agents')
  const { stats } = agent
  const runs = t('detail.meta.runs', { count: stats.runs_total })
  const today = t('detail.meta.today', { count: stats.scheduled_runs_today })
  if (isEngineeringAgent(agent)) {
    const parts = [
      ...(agent.enabled && agent.owner_username !== null ? [t('detail.meta.actsAs', { name: agent.owner_username })] : []),
      t('detail.meta.deploymentFeedback'), runs, today,
    ]
    return <p className="text-[12px] text-muted tabular-nums">{parts.join(' · ')}</p>
  }
  const calls = t('detail.meta.calls', { count: stats.model_calls_this_month, calls: formatCount(stats.model_calls_this_month, i18n.language) })
  return (
    <p className="text-[12px] text-muted tabular-nums">
      <span><ScopeSummary scope={agent.scope} /></span> · {runs} · {today} · {calls}
    </p>
  )
}

export function AutomationHeader({ agent, isAdmin, header }: Readonly<{
  agent: Agent; isAdmin: boolean; header: AutomationView
}>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const reasonId = useId()
  const { state, actions } = header
  return (
    <div className="space-y-3">
      <Link to={agentsPath({ view: 'agents' })} className="inline-flex items-center gap-1 text-[13px] text-muted hover:text-text">
        <ArrowLeft size={14} aria-hidden="true" /> {t('detail.backToAutomations')}
      </Link>
      <div className="flex flex-wrap items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted" aria-hidden="true">
          <AutomationTileIcon agent={agent} size={20} />
        </span>
        <div className="mr-auto min-w-0 flex-1 space-y-0.5">
          <h1 className="text-2xl font-bold tracking-tight text-text-strong break-words [overflow-wrap:anywhere]">{agent.name}</h1>
          {agent.description !== '' && <p className="text-sm text-muted max-w-prose">{agent.description}</p>}
          <MetaLine agent={agent} />
        </div>
        <div className="flex flex-col items-start gap-1 sm:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <AutomationStateChip state={state.state} />
            <PrimaryButton agent={agent} state={state} actions={actions} reasonId={reasonId} emphasis="primary" />
            {isAdmin && (
              <RowActionsMenu label={t('automations.menu.label', { name: agent.name })}
                entries={pageMenuEntries({ agent, state, actions, t, go: (path) => { void navigate(path) } })} />
            )}
          </div>
          <StateReason id={reasonId} state={state} onFix={isAdmin ? () => actions.openSetup('readiness') : undefined} />
          {actions.notice !== '' && <p role="status" className="text-[12px] text-ok">{actions.notice}</p>}
          {actions.error !== '' && <p role="alert" className="text-[12px] text-danger">{actions.error}</p>}
        </div>
      </div>
      {actions.overlays}
    </div>
  )
}
