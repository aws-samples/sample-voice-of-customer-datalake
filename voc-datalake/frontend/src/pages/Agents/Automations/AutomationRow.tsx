/**
 * @fileoverview One automation in the Automations list (7.52.00 C1; ux-agents-redesign part 1 §2.3): one even row with
 * its icon tile, its name (a link to its page) and one line of what it does, its state chip and the one line under it
 * ("▲ 2 to fix", a reason), its last run and its usage, then at most one button (its state's primary,
 * `btn-secondary btn-sm`) and its ⋯ menu, all inside the row. From `md` the cells are columns under the list's header
 * row; below it they stack, the ⋯ beside the name and the button full width.
 *
 * A click on the row's empty space opens the automation (a mouse's shortcut; the name link is the keyboard's path).
 * The buttons name their automation for a screen reader ("Set up *Issue triage*"), the ⋯ is "Actions for Issue
 * triage", and the primary is described by its reason. A person who is not an administrator gets the chip, the last
 * run and the usage, no button and no menu.
 *
 * @module pages/Agents/Automations/AutomationRow
 */
import { useId } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Loader2, Play, Power, Hand, Wrench } from 'lucide-react'
import { RowActionsMenu } from '../../../components/RowActionsMenu/RowActionsMenu'
import { TruncatedText } from '../../../components/Tooltip/TruncatedText'
import { agentPath } from '../agentsPaths'
import { ScopeSummary } from '../AgentBadges'
import { AutomationStateChip, AutomationTileIcon, LastRunCell, StateReason, UsageCell } from './AutomationCells'
import { rowMenuEntries } from './automationMenu'
import { useAutomation } from './useAutomation'
import type { MouseEvent } from 'react'
import type { LucideIcon } from 'lucide-react'
import type { Agent } from '../../../api/agentsApi'
import type { AutomationPrimary, AutomationState } from './automationState'
import type { AutomationActions } from './useAutomationActions'
import type { AutomationFacts } from './useAutomationFacts'

/** The row's grid from `md` (the list header's too): automation, status, last run, usage, actions. */
export const ROW_GRID = 'md:grid md:grid-cols-[minmax(0,1fr)_11rem_12rem_10rem_auto] md:items-center md:gap-x-4'

const PRIMARY_ICONS: Readonly<Record<AutomationPrimary, LucideIcon>> = {
  set_up: Wrench, fix: Wrench, resume: Play, enable: Power, run_now: Play, review: Hand,
}

/**
 * The state's one button: the visible verb, the automation's name for a screen reader, described by its reason. A
 * row's is `btn-secondary` (a calm list); the automation's page header's is its one `btn-primary`.
 */
export function PrimaryButton({ agent, state, actions, reasonId, className, emphasis = 'secondary' }: Readonly<{
  agent: Agent; state: AutomationState; actions: AutomationActions; reasonId?: string; className?: string
  emphasis?: 'primary' | 'secondary'
}>) {
  const { t } = useTranslation('agents')
  const { primary } = state
  if (primary === null) return null
  const Icon = actions.pending ? Loader2 : PRIMARY_ICONS[primary]
  return (
    <button type="button" className={clsx('btn btn-sm justify-center', emphasis === 'primary' ? 'btn-primary' : 'btn-secondary', className)}
      aria-disabled={actions.pending || undefined}
      aria-describedby={reasonId} onClick={() => { if (!actions.pending) actions.primary(primary) }}>
      <Icon size={14} className={actions.pending ? 'animate-spin' : undefined} aria-hidden="true" />
      {t(`automations.actions.${primary}`)}
      {' '}<span className="sr-only">{agent.name}</span>
    </button>
  )
}

/** A mouse click on the row's empty space opens the automation; a control's own click is its own. */
function openOnEmptySpace(open: () => void) {
  return (event: MouseEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('a, button, input, select, [role="menu"]') === null) open()
  }
}

/** `emphasis`: the row's button is the area's one primary where the row stands alone (a setup guide step). */
export function AutomationRow({ agent, isAdmin, facts, emphasis = 'secondary' }: Readonly<{
  agent: Agent; isAdmin: boolean; facts: AutomationFacts; emphasis?: 'primary' | 'secondary'
}>) {
  const { t } = useTranslation('agents')
  const navigate = useNavigate()
  const reasonId = useId()
  const { state, actions } = useAutomation(agent, isAdmin, facts, { removal: 'delete' })
  const open = () => { void navigate(agentPath(agent.agent_id)) }
  const menu = isAdmin
    ? <RowActionsMenu label={t('automations.menu.label', { name: agent.name })} entries={rowMenuEntries({ agent, state, actions, t, go: (path) => { void navigate(path) } })} />
    : null
  return (
    <li className="bg-card hover:bg-bg-hover transition-colors" data-testid={`automation-${agent.agent_id}`}>
      <div className={clsx('flex flex-col gap-2 px-4 py-3', ROW_GRID)} onClick={openOnEmptySpace(open)}>
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-bg-hover text-muted" aria-hidden="true">
            <AutomationTileIcon agent={agent} size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <Link to={agentPath(agent.agent_id)} className="text-sm font-semibold text-text-strong hover:text-accent-text focus-ring rounded-sm break-words [overflow-wrap:anywhere]">
              {agent.name}
            </Link>
            {agent.description === ''
              ? <p className="text-[12px] text-muted line-clamp-2"><ScopeSummary scope={agent.scope} /></p>
              : <TruncatedText as="p" className="text-[12px] text-muted line-clamp-2 break-words [overflow-wrap:anywhere]" text={agent.description} />}
          </div>
          {menu !== null && <span className="md:hidden">{menu}</span>}
        </div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 md:flex-col md:items-start">
          <span className="sr-only">{t('automations.columns.status')}: </span>
          <AutomationStateChip state={state.state} />
          <StateReason id={reasonId} state={state} onFix={isAdmin ? () => actions.openSetup('readiness') : undefined} />
          {actions.notice !== '' && <span role="status" className="text-[12px] text-ok">{actions.notice}</span>}
          {actions.error !== '' && <span role="alert" className="text-[12px] text-danger">{actions.error}</span>}
        </div>
        <div className="min-w-0">
          <span className="sr-only">{t('automations.columns.lastRun')}: </span>
          <LastRunCell agent={agent} />
        </div>
        <div className="min-w-0">
          <span className="sr-only">{t('automations.columns.usage')}: </span>
          <UsageCell agent={agent} spend={facts.spendOf(agent)} />
        </div>
        <div className="flex items-center justify-end gap-1">
          <PrimaryButton agent={agent} state={state} actions={actions} reasonId={reasonId} emphasis={emphasis}
            className="min-h-9 w-full md:min-h-0 md:w-auto" />
          {menu !== null && <span className="hidden md:inline-flex">{menu}</span>}
        </div>
      </div>
      {actions.overlays}
    </li>
  )
}
