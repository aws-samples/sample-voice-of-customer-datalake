/**
 * @fileoverview GitHub Issues insight on the Dashboard: feedback per software
 * release (volume, 👍-weighted reach, average sentiment), what is new in the
 * latest release, its top complaints, and a per-label breakdown.
 *
 * Rendered only when the window holds `github_issues` feedback (the parent
 * decides from /metrics/sources), so other deployments see no empty card.
 *
 * @module pages/Dashboard/GitHubInsights
 */
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { Activity, GitBranch, Sparkles, Tag } from 'lucide-react'
import { api, type DateRangeParams } from '../../api/client'
import ReleaseWatchSection from '../../components/ReleaseWatch/ReleaseWatchSection'
import type { SourceBreakdown } from '../../api/types'
import type { GithubLabelRow, GithubMetrics, GithubRanked, GithubVersionRow } from '../../api/githubMetricsSchema'
import { sentimentCssVar } from '../../lib/sentiment'
import { formatCount } from '../../utils/numberFormat'
import { sentimentTone, sentimentWords, signedAverage } from '../../components/SentimentWords/sentimentWords'
import DashboardCard from './DashboardCard'
import { partialHintText } from './dashboardData'
import { AXIS_LINE, AXIS_TICK, BAR_CURSOR, CHART_CONTAINER_PROPS, GRID_STROKE, TOOLTIP_PROPS } from './chartTheme'
import { NUMBER_AXIS_WIDTH, sentimentTickFormatter } from './axisLabel'
import { useCompactTick } from './useCompactTick'

const SENTIMENT_DOMAIN: [number, number] = [-1, 1]
/** Room for "-0.5" at the axis font (4 × 7 px + the tick line). */
const SENTIMENT_AXIS_WIDTH = 36

/** A row's average in words (its colour follows the words), the number kept beside it: "Mostly negative (−0.78)". */
function SentimentValue({ score }: Readonly<{ score: number | null }>) {
  const { t, i18n } = useTranslation('dashboard')
  if (score === null) return <span>–</span>
  const tone = sentimentTone(score)
  return <span style={{ color: sentimentCssVar(tone) }}>{`${sentimentWords(t, score)} (${signedAverage(score, i18n.language)})`}</span>
}

function ReleaseChart({ versions }: Readonly<{ versions: GithubVersionRow[] }>) {
  const { t, i18n } = useTranslation('dashboard')
  const tick = useCompactTick()
  const sentimentTick = sentimentTickFormatter(i18n.language)
  const data = versions.map((row) => ({
    version: row.version,
    [t('github.reports')]: row.count,
    [t('github.avgSentiment')]: row.avg_sentiment,
  }))
  return (
    <div className="h-[250px] sm:h-[300px] -mx-2 sm:mx-0" data-testid="github-release-chart">
      <ResponsiveContainer {...CHART_CONTAINER_PROPS}>
        <ComposedChart data={data} margin={{ left: 0, right: 10 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
          <XAxis dataKey="version" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} />
          <YAxis yAxisId="count" tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={NUMBER_AXIS_WIDTH} tickFormatter={tick} />
          {/* Ticks run -1 … 1 ("-0.5" is the longest, 4 characters). */}
          <YAxis yAxisId="sentiment" orientation="right" domain={SENTIMENT_DOMAIN} tick={AXIS_TICK} axisLine={AXIS_LINE} tickLine={AXIS_LINE} width={SENTIMENT_AXIS_WIDTH} tickFormatter={sentimentTick} />
          <Tooltip {...TOOLTIP_PROPS} cursor={BAR_CURSOR} />
          <Bar yAxisId="count" dataKey={t('github.reports')} fill="var(--chart-3)" radius={[4, 4, 0, 0]} />
          <Line yAxisId="sentiment" dataKey={t('github.avgSentiment')} stroke="var(--chart-1)" strokeWidth={2} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}

function RankedList({ title, rows }: Readonly<{ title: string; rows: GithubRanked[] }>) {
  const { i18n } = useTranslation()
  if (rows.length === 0) return null
  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted mb-1">{title}</h3>
      <ul className="space-y-1 text-sm">
        {rows.map((row) => (
          <li key={row.name} className="flex justify-between gap-3">
            <span className="min-w-0 wrap-anywhere font-mono text-xs text-text">{row.name}</span>
            <span className="text-muted tabular-nums">{formatCount(row.count, i18n.language)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function LatestRelease({ metrics }: Readonly<{ metrics: GithubMetrics }>) {
  const { t } = useTranslation('dashboard')
  const latest = metrics.versions.at(-1)
  if (!latest || metrics.latestVersion === null) {
    return <p className="text-sm text-muted">{t('github.noVersions')}</p>
  }
  const { errors, categories, components } = metrics.newInLatest
  const nothingNew = errors.length + categories.length + components.length === 0
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {metrics.previousVersion === null
          ? t('github.onlyOneRelease', { version: metrics.latestVersion })
          : t('github.comparedWith', { version: metrics.latestVersion, previous: metrics.previousVersion })}
      </p>
      {metrics.previousVersion !== null && nothingNew && <p className="text-sm text-muted">{t('github.nothingNew')}</p>}
      <RankedList title={t('github.newErrors')} rows={errors} />
      <RankedList title={t('github.newComponents')} rows={components} />
      <RankedList title={t('github.newCategories')} rows={categories} />
      <RankedList title={t('github.topComplaints')} rows={latest.top_complaints} />
      <RankedList title={t('github.topErrors')} rows={latest.top_errors} />
    </div>
  )
}

function LabelTable({ labels }: Readonly<{ labels: GithubLabelRow[] }>) {
  const { t, i18n } = useTranslation('dashboard')
  const count = (n: number) => formatCount(n, i18n.language)
  if (labels.length === 0) return <p className="text-sm text-muted">{t('github.noLabels')}</p>
  return (
    // Focusable and named: the table scrolls sideways on a phone (axe
    // scrollable-region-focusable, design audit).
    <div className="overflow-x-auto rounded-md focus-ring" tabIndex={0} role="region" aria-label={t('github.byLabel')}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted">
            <th scope="col" className="py-1 pr-3 font-medium">{t('github.label')}</th>
            <th scope="col" className="py-1 pr-3 font-medium text-right">{t('github.reports')}</th>
            <th scope="col" className="py-1 pr-3 font-medium text-right">{t('github.reach')}</th>
            <th scope="col" className="py-1 pr-3 font-medium text-right">{t('github.open')}</th>
            <th scope="col" className="py-1 font-medium text-right">{t('github.avgSentiment')}</th>
          </tr>
        </thead>
        <tbody>
          {labels.map((row) => (
            <tr key={row.label} className="border-t border-border">
              <th scope="row" className="py-1 pr-3 font-normal text-text break-words max-w-[12rem]">{row.label}</th>
              <td className="py-1 pr-3 text-right tabular-nums">{count(row.count)}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{count(row.weight)}</td>
              <td className="py-1 pr-3 text-right tabular-nums">{count(row.open)}</td>
              <td className="py-1 text-right tabular-nums"><SentimentValue score={row.avg_sentiment} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function RepoPicker({ repos, value, onChange }: Readonly<{ repos: string[]; value: string; onChange: (repo: string) => void }>) {
  const { t } = useTranslation('dashboard')
  if (repos.length < 2 && value === '') return null
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} aria-label={t('github.repo')} className="select w-auto">
      <option value="">{t('github.allRepos')}</option>
      {repos.map((repo) => <option key={repo} value={repo}>{repo}</option>)}
    </select>
  )
}

/** The plugin id GitHub Issues feedback is stored under (plugins/github_issues). */
const GITHUB_SOURCE = 'github_issues'

export default function GitHubInsights({ dateParams, sources }: Readonly<{ dateParams: DateRangeParams; sources: SourceBreakdown | undefined }>) {
  const { t } = useTranslation(['dashboard', 'common', 'decisions'])
  const enabled = (sources?.sources[GITHUB_SOURCE] ?? 0) > 0
  const [repo, setRepo] = useState('')
  const { data } = useQuery({
    queryKey: ['githubMetrics', dateParams, repo],
    queryFn: () => api.getGithubMetrics(dateParams, repo || undefined),
    enabled,
  })
  if (!enabled || !data || (data.total === 0 && repo === '')) return null

  const hint = partialHintText(data.partial.isPartial, data.partial.scannedThrough, t)
  return (
    <section className="space-y-4 sm:space-y-6" aria-labelledby="github-insights-heading">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 id="github-insights-heading" className="text-lg sm:text-xl font-semibold tracking-tight text-text-strong">
            {t('dashboard:github.title')}
          </h2>
          <p className="text-sm text-muted mt-1">
            {t('dashboard:github.subtitle', { count: data.total, unversioned: data.unversioned.count })}
          </p>
          {hint && <p className="text-xs text-warn mt-1">{hint}</p>}
        </div>
        <RepoPicker repos={data.repos} value={repo} onChange={setRepo} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6 items-start">
        <DashboardCard icon={<GitBranch className="text-accent-text flex-shrink-0" size={18} aria-hidden="true" />} title={t('dashboard:github.byRelease')}>
          {data.versions.length > 0 ? <ReleaseChart versions={data.versions} /> : <p className="text-sm text-muted">{t('dashboard:github.noVersions')}</p>}
        </DashboardCard>
        <DashboardCard icon={<Sparkles className="text-accent-text flex-shrink-0" size={18} aria-hidden="true" />} title={t('dashboard:github.newSinceLast')}>
          <LatestRelease metrics={data} />
        </DashboardCard>
      </div>
      <DashboardCard icon={<Tag className="text-accent-text flex-shrink-0" size={18} aria-hidden="true" />} title={t('dashboard:github.byLabel')}>
        <LabelTable labels={data.labels} />
      </DashboardCard>
      <DashboardCard icon={<Activity className="text-accent-text flex-shrink-0" size={18} aria-hidden="true" />} title={t('decisions:releaseWatch.title')}>
        <ReleaseWatchSection query={{}} />
      </DashboardCard>
    </section>
  )
}
