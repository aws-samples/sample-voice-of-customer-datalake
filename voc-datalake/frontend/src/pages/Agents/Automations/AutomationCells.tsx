/**
 * @fileoverview An automation's cells (7.52.00 C1; ux-agents-redesign part 1 §2.3), shared by the list's row and the
 * automation's page header:
 *
 * - **the state chip:** one `IconBadge` per state, text and icon (rule 15), a skeleton while its reads load;
 * - **the reason line under it:** "▲ 2 to fix" (a link-styled button that opens the drawer at its readiness), else
 *   "1 warning", "Couldn't check", "Its repository connection was removed.", or a cap's skip;
 * - **Last run:** "No runs yet", "Running · started 3 min ago", "Needs your decision", or the status and when, a link
 *   to its runs;
 * - **Usage:** an engineering automation's month against its flow's budget ("$1.20 of $50", marked from 80 %), a
 *   product one's model calls ("214 of 5,000" when capped); and "3 scheduled runs today".
 *
 * Numbers are in the body font with `tabular-nums`, never mono.
 *
 * @module pages/Agents/Automations/AutomationCells
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import {
  AlertTriangle, Bot, Bug, CircleAlert, CircleCheck, CircleDot, CirclePause, CircleX, Hammer, Hand, ListChecks, Loader2, Wrench,
} from 'lucide-react'
import { IconBadge } from '../../../components/IconBadge/IconBadge'
import { formatRelativeDate } from '../../../utils/dateUtils'
import { formatCount } from '../../../utils/numberFormat'
import { isEngineeringAgent } from '../../../api/agentsApi'
import { agentPath } from '../agentsPaths'
import { budgetShare, shareTone } from '../spendView'
import { STATE_TONES } from './automationState'
import type { LucideIcon } from 'lucide-react'
import type { TFunction } from 'i18next'
import type { Agent, RunStatus } from '../../../api/agentsApi'
import type { AutomationState, AutomationStateId } from './automationState'

const STATE_ICONS: Readonly<Record<AutomationStateId, LucideIcon>> = {
  needs_setup: Wrench, cant_run: CircleAlert, paused: CirclePause, ready: CircleDot, enabled: CircleCheck,
}

/** What the automation works on: issue triage, bugs or features; a product automation's projects. */
function tileKind(agent: Agent): 'triage' | 'bug' | 'feature' | 'product' {
  if (!isEngineeringAgent(agent)) return 'product'
  if (agent.triggers.some((trigger) => trigger.kind === 'github_issue' && trigger.stage === 'triage')) return 'triage'
  return agent.engineering?.feedback_type === 'feature_request' ? 'feature' : 'bug'
}

/** The tile's icon (ListChecks, Bug, Hammer, Bot), `text-muted` on its tile: never an identity colour. */
export function AutomationTileIcon({ agent, size }: Readonly<{ agent: Agent; size: 16 | 20 }>) {
  const kind = tileKind(agent)
  if (kind === 'product') return <Bot size={size} />
  if (kind === 'triage') return <ListChecks size={size} />
  return kind === 'feature' ? <Hammer size={size} /> : <Bug size={size} />
}

export function AutomationStateChip({ state }: Readonly<{ state: AutomationState['state'] }>) {
  const { t } = useTranslation('agents')
  if (state === 'loading') {
    return <span className="skeleton inline-block h-5 w-24" role="status" aria-label={t('automations.state.loading')} />
  }
  return (
    <IconBadge toneClass={STATE_TONES[state]} icon={STATE_ICONS[state]} data-state={state} className="self-start">
      {t(`automations.state.${state}`)}
    </IconBadge>
  )
}

/** The one line under the chip: what to fix (a way into the drawer), a warning, a reason, or a read that failed. */
export function StateReason({ state, onFix, id }: Readonly<{ state: AutomationState; onFix?: () => void; id?: string }>) {
  const { t } = useTranslation('agents')
  if (state.toFix > 0) {
    const text = <><AlertTriangle size={13} aria-hidden="true" /> {t('automations.toFix', { count: state.toFix })}</>
    return onFix === undefined
      ? <span id={id} className="inline-flex items-center gap-1 text-[12px] text-warn">{text}</span>
      : <button id={id} type="button" className="link inline-flex items-center gap-1 text-[12px]" onClick={onFix}>{text}</button>
  }
  if (state.unchecked) return <span id={id} className="text-[12px] text-muted">{t('automations.unchecked')}</span>
  if (state.reason !== null) {
    return <span id={id} className={clsx('text-[12px]', state.reason === 'connection_gone' ? 'text-danger' : 'text-muted')}>{t(`automations.reason.${state.reason}`)}</span>
  }
  if (state.warnings > 0) {
    return onFix === undefined
      ? <span id={id} className="text-[12px] text-muted">{t('automations.warnings', { count: state.warnings })}</span>
      : <button id={id} type="button" className="link text-[12px]" onClick={onFix}>{t('automations.warnings', { count: state.warnings })}</button>
  }
  return null
}

const RUN_LOOK: Readonly<Record<RunStatus, { icon: LucideIcon; tone: string; spin?: boolean }>> = {
  queued: { icon: Loader2, tone: 'text-accent', spin: true },
  running: { icon: Loader2, tone: 'text-accent', spin: true },
  needs_human: { icon: Hand, tone: 'text-warn' },
  completed: { icon: CircleCheck, tone: 'text-ok' },
  failed: { icon: CircleX, tone: 'text-danger' },
  cancelled: { icon: CircleX, tone: 'text-muted' },
}

/** Whether a run of the automation is under way (its lock, or a last run still queued or running). */
const isLive = (agent: Agent): boolean =>
  agent.stats.active_run_id !== null || agent.stats.last_run_status === 'running' || agent.stats.last_run_status === 'queued'

/** The last run's words: live, waiting for a person, or its status and when. */
function lastRunWords(agent: Agent, t: TFunction<'agents'>, when: string): string {
  const status = agent.stats.last_run_status
  if (isLive(agent)) return t('automations.activity.running', { when })
  if (status === 'needs_human') return t('automations.activity.needsDecision')
  const label = status === null ? '' : t(`run.status.${status}`)
  return t('automations.activity.ended', { status: label, when })
}

/** Its last run: none yet, live, waiting for a person, or ended; a link to its runs (where each run opens). */
export function LastRunCell({ agent }: Readonly<{ agent: Agent }>) {
  const { t, i18n } = useTranslation('agents')
  const { stats } = agent
  if (stats.last_run_status === null && stats.runs_total === 0) {
    return <span className="text-[12px] text-muted">{t('automations.activity.none')}</span>
  }
  const look = RUN_LOOK[isLive(agent) ? 'running' : stats.last_run_status ?? 'completed']
  const Icon = look.icon
  const words = lastRunWords(agent, t, formatRelativeDate(stats.last_run_at, i18n.language))
  return (
    <Link to={agentPath(agent.agent_id, 'runs')} className="link inline-flex items-center gap-1 text-[12px] tabular-nums">
      <Icon size={13} className={clsx('shrink-0', look.tone, look.spin === true && 'animate-spin')} aria-hidden="true" />
      {words}
    </Link>
  )
}

function useUsd() {
  const { i18n } = useTranslation()
  const usd = new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
  return (value: number) => usd.format(value)
}

/** An engineering automation's month: spent of its flow's budget, marked from 80 %; "—" when not known. */
function EngineeringUsage({ usd, budget }: Readonly<{ usd: number | null; budget: number | null }>) {
  const { t } = useTranslation('agents')
  const format = useUsd()
  if (usd === null) return <span className="text-muted">—</span>
  if (budget === null) return <span>{format(usd)}</span>
  const percent = budgetShare(usd, budget)
  const tone = shareTone(percent)
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {t('automations.activity.spentOf', { amount: format(usd), budget: format(budget) })}
      {tone !== '' && <span className={tone}>{t('spend.budgetShare', { percent })}</span>}
    </span>
  )
}

/** A product automation's model calls this month ("214 of 5,000" when capped). */
function ProductUsage({ agent }: Readonly<{ agent: Agent }>) {
  const { t, i18n } = useTranslation('agents')
  const count = agent.stats.model_calls_this_month
  const calls = formatCount(count, i18n.language)
  const cap = agent.budget.monthly_call_cap
  if (cap === null) return <span>{t('automations.activity.calls', { count, calls })}</span>
  return <span>{t('automations.activity.callsOf', { calls, cap: formatCount(cap, i18n.language) })}</span>
}

/** Usage (module doc): what it spent or the model calls it made this month, and today's scheduled runs. */
export function UsageCell({ agent, spend }: Readonly<{ agent: Agent; spend: { usd: number | null; budget: number | null } }>) {
  const { t } = useTranslation('agents')
  const { stats } = agent
  return (
    <span className="flex flex-col text-[12px] text-text tabular-nums">
      {isEngineeringAgent(agent) ? <EngineeringUsage usd={spend.usd} budget={spend.budget} /> : <ProductUsage agent={agent} />}
      {stats.scheduled_runs_today > 0 && (
        <span className="text-muted">{t('automations.activity.scheduledToday', { count: stats.scheduled_runs_today })}</span>
      )}
    </span>
  )
}
