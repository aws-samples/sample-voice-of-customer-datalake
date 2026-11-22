/**
 * @fileoverview Insights → Leadership (7.70.00, idea 8; docs/leadership-view.md): how the teams use the method, on
 * one page, by month or quarter: projects started and how far they got (ideas taken to prototype), validations and
 * validated decisions, decisions by verdict, median cycle times, artifacts made with AI or by hand, assistant and
 * agent use, and the time saved as a labelled estimate with its assumptions beside it (owner decision 11). Counts
 * only: there is no per-person view and no leaderboard.
 *
 * The scope is the request's (`X-Workspace-Id`): a workspace's admins see their workspace's view; outside one the
 * deployment's admins and platform admins see the deployment's, and a platform admin finds the platform's model cost
 * estimate named beside it. The figures come from the daily rollup (`as_of`); a CSV holds the same rows.
 * @module pages/Leadership
 */
import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { adoptionApi, adoptionKey } from '../../api/adoptionApi'
import type { AdoptionView, Grain } from '../../api/adoptionApi'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import PageLoader from '../../components/PageLoader/PageLoader'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import { formatDateTime } from '../../utils/dateUtils'
import { formatCount } from '../../utils/numberFormat'
import AssumptionsDrawer from './AssumptionsDrawer'
import { ProjectsChart, WaysOfWorkingChart } from './LeadershipCharts'
import LeadershipFilters from './LeadershipFilters'
import LeadershipKpis from './LeadershipKpis'
import { downloadLeadershipCsv } from './leadershipCsv'
import { presetRange } from './leadershipRange'
import type { RangePreset } from './leadershipRange'
import { CycleTimes, DecisionsSection, MethodCoverage } from './MethodSections'
import PeriodTable from './PeriodTable'
import { useLeadershipAccess } from './useLeadershipAccess'
import type { LeadershipAccess } from './useLeadershipAccess'

function AsOf({ view }: Readonly<{ view: AdoptionView }>) {
  const { t, i18n } = useTranslation('leadership')
  if (view.as_of === null) return <p className="text-sm text-muted" role="note">{t('asOf.none')}</p>
  const when = formatDateTime(view.as_of, i18n.language)
  return (
    <p className="text-sm text-muted">
      {t('asOf.at', { when })}
      {view.complete ? null : <span className="text-warn"> {t('asOf.partial')}</span>}
    </p>
  )
}

function Usage({ view, access }: Readonly<{ view: AdoptionView; access: LeadershipAccess }>) {
  const { t, i18n } = useTranslation('leadership')
  const totals = view.totals
  return (
    <section className="card space-y-2" aria-label={t('usage.title')}>
      <h2 className="text-base font-semibold text-text-strong">{t('usage.title')}</h2>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-sm text-muted">{t('usage.conversations')}</dt>
          <dd className="text-2xl font-semibold font-mono text-text-strong">
            {formatCount(totals.assistant_conversations, i18n.language)}
          </dd>
        </div>
        <div>
          <dt className="text-sm text-muted">{t('usage.agentRuns')}</dt>
          <dd className="text-2xl font-semibold font-mono text-text-strong">
            {view.agent_runs_counted ? formatCount(totals.agent_runs, i18n.language) : '—'}
          </dd>
          {view.agent_runs_counted ? null : <dd className="text-xs text-muted">{t('usage.agentsDeploymentOnly')}</dd>}
        </div>
      </dl>
      <p className="text-xs text-muted">{t('usage.note')}</p>
      {access.showsPlatformCost ? <p className="text-xs text-muted">{t('usage.platformCost')}</p> : null}
    </section>
  )
}

function LeadershipContent({ access }: Readonly<{ access: LeadershipAccess }>) {
  const { t } = useTranslation('leadership')
  const [preset, setPreset] = useState<RangePreset>('last6')
  const [grain, setGrain] = useState<Grain>('month')
  const [assumptionsOpen, setAssumptionsOpen] = useState(false)
  const range = useMemo(() => presetRange(preset, grain, new Date()), [preset, grain])
  const query = useQuery({ queryKey: adoptionKey(range), queryFn: () => adoptionApi.view(range) })
  const view = query.data
  return (
    <>
      <LeadershipFilters preset={preset} grain={grain} onPreset={setPreset} onGrain={setGrain}
        onAssumptions={() => setAssumptionsOpen(true)}
        onCsv={view === undefined ? undefined : () => downloadLeadershipCsv(view)} />
      {query.isPending ? <PageLoader /> : null}
      {query.isError ? <LoadFailed onRetry={() => void query.refetch()} retrying={query.isFetching}
        message={t('loadFailed')} /> : null}
      {view === undefined ? null : (
        <>
          <AsOf view={view} />
          <LeadershipKpis view={view} onAssumptions={() => setAssumptionsOpen(true)} />
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <ProjectsChart periods={view.periods} />
            <MethodCoverage totals={view.totals} />
            <WaysOfWorkingChart totals={view.totals} />
            <DecisionsSection totals={view.totals} />
          </div>
          <CycleTimes totals={view.totals} />
          <Usage view={view} access={access} />
          <PeriodTable view={view} />
        </>
      )}
      <AssumptionsDrawer isOpen={assumptionsOpen} onClose={() => setAssumptionsOpen(false)} view={view}
        canEdit={access.canEdit} />
    </>
  )
}

export default function Leadership() {
  const { t } = useTranslation('leadership')
  const access = useLeadershipAccess()
  return (
    <div className="mx-auto w-full min-w-0 max-w-6xl space-y-4 sm:space-y-6">
      <PageTitle title={t('title')} subtitle={t('subtitle')} />
      {access.canRead ? <LeadershipContent access={access} /> : (
        <p className="card text-sm text-muted" role="note">{t('adminsOnly')}</p>
      )}
    </div>
  )
}
