/**
 * @fileoverview The run workspace's header (7.51.00): the run monitor's (goal, status, repository, times, issue and
 * pull request, MicroVM time and tokens, the flow's budget), with the budget this run used against its cap (its
 * tokens at their prices, Learn's apart), what an ended run's manifest recorded, and the runs it was restarted from
 * and as (a child run is a new run of an ended one: D51-3), and the run's control bar.
 *
 * @module pages/Agents/RunWorkspace/RunHeader
 */
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { formatCount } from '../../../utils/numberFormat'
import { EngineeringRunHeader } from '../EngineeringRunHeader'
import { shareTone, budgetShare } from '../spendView'
import { runWorkspacePath } from './runWorkspacePaths'
import { useDollars } from './useDollars'
import type { ReactNode } from 'react'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'

function BudgetMeter({ share }: Readonly<{ share: number }>) {
  const { t } = useTranslation('agents')
  const filled = Math.min(share, 100)
  return (
    <div className="h-1.5 w-full max-w-md overflow-hidden rounded-full bg-bg-hover" role="meter" aria-valuemin={0} aria-valuemax={100}
      aria-valuenow={filled} aria-label={t('runWorkspace.header.budgetUsed')}>
      <div className={share >= 100 ? 'h-full bg-danger' : 'h-full bg-accent'} style={{ width: `${String(filled)}%` }} />
    </div>
  )
}

/** What the run cost so far, against its cap, with Learn's apart. */
function CostLine({ cost, cap, learn, share }: Readonly<{ cost: number; cap: number | null; learn: number | null; share: number | null }>) {
  const { t } = useTranslation('agents')
  const usd = useDollars()
  return (
    <p className="flex flex-wrap items-center gap-2">
      <span>{cap === null ? t('runWorkspace.header.cost', { cost: usd(cost) }) : t('runWorkspace.header.costOfCap', { cost: usd(cost), budget: usd(cap) })}</span>
      {share !== null && <span className={shareTone(share) || 'badge badge-muted'}>{t('runWorkspace.header.share', { percent: share })}</span>}
      {learn !== null && learn > 0 && <span>{t('runWorkspace.header.learn', { cost: usd(learn) })}</span>}
    </p>
  )
}

function RunCost({ run }: Readonly<{ run: EngineeringOverview['run'] }>) {
  const { t, i18n } = useTranslation('agents')
  const usd = useDollars()
  const { cost_usd: cost, cost_cap_usd: cap } = run
  const share = cost !== null && cap !== null && cap > 0 ? budgetShare(cost, cap) : null
  const ended = run.manifest?.cost_usd ?? null
  return (
    <div className="space-y-1 text-[13px] text-muted">
      {cost !== null && <CostLine cost={cost} cap={cap} learn={run.learn_cost_usd} share={share} />}
      {share !== null && <BudgetMeter share={share} />}
      {ended !== null && (
        <p>{t('runWorkspace.header.manifest', { cost: usd(ended), tokens: formatCount(run.manifest?.tokens ?? 0, i18n.language) })}</p>
      )}
    </div>
  )
}

function RunLineage({ overview }: Readonly<{ overview: EngineeringOverview }>) {
  const { t } = useTranslation('agents')
  const { parent } = overview.run
  if (parent === null && overview.children.length === 0) return null
  return (
    <ul className="space-y-0.5 text-[13px]" aria-label={t('runWorkspace.header.lineage')}>
      {parent !== null && (
        <li>
          {t(`runWorkspace.header.parent.${parent.mode === 'restart' ? 'restart' : 'resume'}`)}{' '}
          <Link className="link font-mono" to={runWorkspacePath(parent.run_id)}>{parent.run_id}</Link>
        </li>
      )}
      {overview.children.map((child) => (
        <li key={child.run_id}>
          {t(`runWorkspace.header.child.${child.mode === 'restart' ? 'restart' : 'resume'}`)}{' '}
          <Link className="link font-mono" to={runWorkspacePath(child.run_id)}>{child.run_id}</Link>
        </li>
      ))}
    </ul>
  )
}

/** The header, with the run's control bar (RunControlBar.tsx) at its foot. */
export function RunHeader({ overview, controls }: Readonly<{ overview: EngineeringOverview; controls: ReactNode }>) {
  return (
    <EngineeringRunHeader overview={overview}>
      <RunCost run={overview.run} />
      <RunLineage overview={overview} />
      {controls}
    </EngineeringRunHeader>
  )
}
