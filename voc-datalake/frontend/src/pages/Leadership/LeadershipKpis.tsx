/**
 * @fileoverview The leadership view's headline figures for the range (dataviz: a KPI row of stat tiles, not a
 * chart): projects started, ideas taken to prototype, validations run, validated decisions and the time saved, which
 * is always shown as an estimate with a way to its assumptions beside it.
 * @module pages/Leadership/LeadershipKpis
 */
import { useTranslation } from 'react-i18next'
import { CheckCircle2, Clock, FlaskConical, FolderPlus, Rocket } from 'lucide-react'
import type { AdoptionView } from '../../api/adoptionApi'
import MetricCard from '../../components/MetricCard/MetricCard'
import { formatCount, formatDecimal, formatPercent } from '../../utils/numberFormat'

export default function LeadershipKpis({ view, onAssumptions }: Readonly<{ view: AdoptionView; onAssumptions: () => void }>) {
  const { t, i18n } = useTranslation('leadership')
  const totals = view.totals
  const locale = i18n.language
  const rate = totals.prototype_rate
  return (
    <section aria-label={t('kpis.label')} className="space-y-2">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <MetricCard title={t('kpis.projectsStarted')} value={totals.projects_started}
          icon={<FolderPlus size={20} />} />
        <MetricCard title={t('kpis.toPrototype')} value={rate === null ? '—' : formatPercent(rate * 100, locale)}
          detail={t('kpis.toPrototypeDetail', { reached: formatCount(totals.with.prototype, locale),
            total: totals.projects_started })}
          icon={<Rocket size={20} />} />
        <MetricCard title={t('kpis.validations')} value={totals.validation_reports}
          detail={t('kpis.syntheticRuns', { runs: totals.validation_runs.synthetic })} icon={<FlaskConical size={20} />} />
        <MetricCard title={t('kpis.validatedDecisions')} value={totals.validated_decisions}
          detail={t('kpis.ofDecisions', { total: totals.decisions.total })} icon={<CheckCircle2 size={20} />} />
        <MetricCard title={t('kpis.timeSaved')} color="warn"
          value={t('kpis.hours', { hours: formatDecimal(totals.time_saved_hours, locale, 1) })}
          detail={t('kpis.estimate')} icon={<Clock size={20} />} />
      </div>
      <p className="text-xs text-muted">
        {t('kpis.estimateNote')}{' '}
        <button type="button" className="link" onClick={onAssumptions}>{t('kpis.seeAssumptions')}</button>
      </p>
    </section>
  )
}
