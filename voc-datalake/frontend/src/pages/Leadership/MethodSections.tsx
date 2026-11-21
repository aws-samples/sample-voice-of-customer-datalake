/**
 * @fileoverview The leadership view's method sections for the range (dataviz: a ratio per named row against its own
 * whole is a meter list, not a chart per row; a handful of numbers are stat figures):
 * - how far the projects started in the range got: with personas, research, a PR/FAQ, a PRD, a prototype, a
 *   validation, each a meter against the projects started (one hue, the track a lighter step of it);
 * - decisions by verdict (a meter each against all the range's decisions) and how many were validated;
 * - the median cycle times, each with the number of projects behind it.
 * Every figure is written beside its bar: identity is never the color alone.
 * @module pages/Leadership/MethodSections
 */
import { useTranslation } from 'react-i18next'
import { COHORT_STEPS, CYCLES, VERDICTS } from '../../api/adoptionApi'
import type { AdoptionPeriod } from '../../api/adoptionApi'
import { formatCount, formatPercent } from '../../utils/numberFormat'
import { ChartCard } from './LeadershipCharts'

const FILL = 'var(--chart-2)'
const TRACK = 'color-mix(in srgb, var(--chart-2) 18%, var(--card))'

function Meter({ label, value, whole, figure }: Readonly<{ label: string; value: number; whole: number; figure: string }>) {
  const share = whole > 0 ? Math.min(1, value / whole) : 0
  return (
    <li className="grid grid-cols-1 gap-1 sm:grid-cols-[10rem_1fr_auto] sm:items-center sm:gap-3">
      <span className="text-sm text-text">{label}</span>
      <span className="block h-2 rounded-full" style={{ background: TRACK }} aria-hidden="true">
        <span className="block h-2 rounded-full" style={{ width: `${String(share * 100)}%`, background: FILL }} />
      </span>
      <span className="text-sm font-mono text-text-strong sm:text-right">{figure}</span>
    </li>
  )
}

export function MethodCoverage({ totals }: Readonly<{ totals: AdoptionPeriod }>) {
  const { t, i18n } = useTranslation('leadership')
  const started = totals.projects_started
  return (
    <ChartCard title={t('coverage.title')} subtitle={t('coverage.subtitle', { started: formatCount(started, i18n.language) })}>
      <ul className="space-y-2">
        {COHORT_STEPS.map((step) => {
          const reached = totals.with[step]
          const percent = started > 0 ? formatPercent((reached / started) * 100, i18n.language) : '—'
          return <Meter key={step} label={t(`steps.${step}`)} value={reached} whole={started}
            figure={t('coverage.figure', { percent, reached: formatCount(reached, i18n.language) })} />
        })}
      </ul>
    </ChartCard>
  )
}

export function DecisionsSection({ totals }: Readonly<{ totals: AdoptionPeriod }>) {
  const { t, i18n } = useTranslation('leadership')
  const decided = totals.decisions.total
  return (
    <ChartCard title={t('decisions.title')} subtitle={t('decisions.subtitle', { total: decided })}>
      <ul className="space-y-2">
        {VERDICTS.map((verdict) => (
          <Meter key={verdict} label={t(`decisions.verdicts.${verdict}`)} value={totals.decisions[verdict]}
            whole={decided} figure={formatCount(totals.decisions[verdict], i18n.language)} />
        ))}
        <Meter label={t('decisions.validated')} value={totals.validated_decisions} whole={decided}
          figure={formatCount(totals.validated_decisions, i18n.language)} />
      </ul>
      <p className="text-xs text-muted">{t('decisions.validatedNote')}</p>
    </ChartCard>
  )
}

export function CycleTimes({ totals }: Readonly<{ totals: AdoptionPeriod }>) {
  const { t } = useTranslation('leadership')
  return (
    <ChartCard title={t('cycles.title')} subtitle={t('cycles.subtitle')}>
      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        {CYCLES.map((cycle) => {
          const { median, n } = totals.cycle_days[cycle]
          return (
            <div key={cycle} className="rounded-lg border border-border p-3">
              <dt className="text-sm text-muted">{t(`cycles.${cycle}`)}</dt>
              <dd className="text-2xl font-semibold font-mono text-text-strong">
                {median === null ? '—' : t('cycles.days', { days: median })}
              </dd>
              <dd className="text-xs text-muted">{t('cycles.projects', { n })}</dd>
            </div>
          )
        })}
      </dl>
    </ChartCard>
  )
}
