/**
 * @fileoverview A scale question's results (UX §10.2): a rating's average ("3.8 of 5") and its histogram with the
 * end labels; NPS's score (−100 to 100, signed), its detractors / passives / promoters in one stacked bar (status
 * tones, each named in text) and the 0–10 histogram; CSAT's "% satisfied" (4–5); CES's average and "% easy" (5–7).
 *
 * @module pages/FeedbackForms/results/ScaleResult
 */
import { useTranslation } from 'react-i18next'
import type { QuestionAggregate } from '../../../api/feedbackFormsV2Results'
import type { FormLanguage, RatingQuestion, ScoreQuestion } from '../model/formsV2'
import { textIn } from '../model/i18nText'
import { scaleOf } from '../model/rules'
import { formatCount, formatDecimal, formatPercent } from '../../../utils/numberFormat'
import BarRow from './BarRow'
import type { ScoreCount } from './scoreMath'
import { averageOf, countFrom, distributionRows, npsGroups, percentOf, signedScore, totalOf } from './scoreMath'

function Headline({ value, label }: Readonly<{ value: string; label: string }>) {
  return (
    <p className="flex flex-wrap items-baseline gap-2">
      <span className="text-2xl font-bold tabular-nums text-text-strong">{value}</span>
      <span className="text-sm text-muted">{label}</span>
    </p>
  )
}

function Histogram({ rows, lower, upper }: Readonly<{ rows: readonly ScoreCount[]; lower: string; upper: string }>) {
  const { t } = useTranslation('feedbackForms')
  const total = totalOf(rows)
  const first = rows[0]?.score
  const last = rows.at(-1)?.score
  const label = (score: number) => {
    if (score === first && lower !== '') return t('results.scale.pointLabel', { score, label: lower })
    if (score === last && upper !== '') return t('results.scale.pointLabel', { score, label: upper })
    return String(score)
  }
  return (
    <ul className="space-y-1.5" aria-label={t('results.scale.distribution')}>
      {rows.map((row) => <BarRow key={row.score} label={label(row.score)} count={row.count} percent={percentOf(row.count, total)} />)}
    </ul>
  )
}

const GROUP_COLORS = { detractors: 'var(--danger)', passives: 'var(--muted)', promoters: 'var(--ok)' } as const

function NpsSummary({ rows }: Readonly<{ rows: readonly ScoreCount[] }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const groups = npsGroups(rows)
  const share = (count: number) => percentOf(count, groups.total)
  const parts = (['detractors', 'passives', 'promoters'] as const).map((group) => ({ group, count: groups[group] }))
  const names = { detractors: t('results.scale.detractors'), passives: t('results.scale.passives'), promoters: t('results.scale.promoters') }
  return (
    <div className="space-y-3">
      <Headline value={groups.score === null ? '—' : signedScore(groups.score)} label={t('results.scale.npsScore')} />
      <span aria-hidden="true" className="flex h-3 w-full overflow-hidden rounded-full bg-bg-hover">
        {parts.map(({ group, count }) => (
          <span key={group} className="block h-full" style={{ width: `${String(share(count))}%`, backgroundColor: GROUP_COLORS[group] }} />
        ))}
      </span>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-text" aria-label={t('results.scale.groups')}>
        {parts.map(({ group, count }) => (
          <li key={group} className="flex items-center gap-1.5">
            <span aria-hidden="true" className="h-2 w-2 rounded-full" style={{ backgroundColor: GROUP_COLORS[group] }} />
            {names[group]} <span className="tabular-nums">{formatCount(count, i18n.language)} · {formatPercent(share(count), i18n.language)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function ScoreHeadline({ question, rows }: Readonly<{ question: RatingQuestion | ScoreQuestion; rows: readonly ScoreCount[] }>) {
  const { t, i18n } = useTranslation('feedbackForms')
  const average = averageOf(rows)
  const total = totalOf(rows)
  const scale = scaleOf(question)
  const max = scale?.max ?? 0
  const avg = average === null ? '—' : t('results.scale.averageOf', { average: formatDecimal(average, i18n.language, 1), max })
  switch (question.type) {
    case 'nps': return <NpsSummary rows={rows} />
    case 'csat': return <Headline value={formatPercent(percentOf(countFrom(rows, 4), total), i18n.language)} label={t('results.scale.satisfied')} />
    case 'ces': return (
      <div className="flex flex-wrap gap-6">
        <Headline value={avg} label={t('results.scale.average')} />
        <Headline value={formatPercent(percentOf(countFrom(rows, 5), total), i18n.language)} label={t('results.scale.easy')} />
      </div>
    )
    case 'rating': return <Headline value={avg} label={t('results.scale.average')} />
  }
}

export default function ScaleResult({ question, aggregate, language }: Readonly<{
  question: RatingQuestion | ScoreQuestion
  aggregate: QuestionAggregate
  language: FormLanguage
}>) {
  const scale = scaleOf(question) ?? { min: 1, max: 5 }
  const rows = distributionRows(aggregate.distribution, scale.min, scale.max)
  return (
    <div className="space-y-4">
      <ScoreHeadline question={question} rows={rows} />
      <Histogram rows={rows} lower={textIn(question.lower_label, language)} upper={textIn(question.upper_label, language)} />
    </div>
  )
}
