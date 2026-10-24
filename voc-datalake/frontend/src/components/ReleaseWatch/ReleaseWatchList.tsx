/**
 * @fileoverview Release watch rows: feedback before and after each release, the
 * regression flag computed by the server (`lambda/shared/release_watch.py`), the
 * top categories before → after, the complaints that grew and the most negative
 * items after the release.
 * @module components/ReleaseWatch/ReleaseWatchList
 */
import { CircleCheck, TrendingDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import ReviewLink from '../ReviewLink/ReviewLink'
import TopCategoryShift from './TopCategoryShift'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import { signedAverage } from '../SentimentWords/sentimentWords'
import { formatCount } from '../../utils/numberFormat'
import type { ReleaseSide, ReleaseWatchEntry } from '../../api/releaseWatchSchema'

const EVIDENCE_SHOWN = 3

/** The average on the −1 … +1 scale, signed, with the locale's decimal mark ("−0,42"); "–" when unknown. */
function formatSentiment(value: number | null, language: string): string {
  return value === null ? '–' : signedAverage(value, language)
}

function SideStats({ label, side }: Readonly<{ label: string; side: ReleaseSide }>) {
  const { t, i18n } = useTranslation('decisions')
  return (
    <div className="min-w-0">
      <p className="text-xs text-muted">{label}</p>
      <dl className="grid grid-cols-3 gap-2 text-sm mt-1">
        <div><dt className="text-xs text-muted">{t('releaseWatch.volume')}</dt><dd className="font-mono">{formatCount(side.count, i18n.language)}</dd></div>
        <div><dt className="text-xs text-muted">{t('releaseWatch.negative')}</dt><dd className="font-mono">{formatCount(side.negative, i18n.language)}</dd></div>
        <div><dt className="text-xs text-muted">{t('releaseWatch.sentiment')}</dt><dd className="font-mono">{formatSentiment(side.avg_sentiment, i18n.language)}</dd></div>
      </dl>
    </div>
  )
}

function RegressionBadge({ entry }: Readonly<{ entry: ReleaseWatchEntry }>) {
  const { t } = useTranslation('decisions')
  if (!entry.regression) {
    return (
      <span className="badge badge-ok inline-flex items-center gap-1">
        <CircleCheck size={12} aria-hidden />{t('releaseWatch.noRegression')}
      </span>
    )
  }
  const reasons = entry.reasons.map((reason) => t(`releaseWatch.reasons.${reason}`, { defaultValue: reason }))
  return (
    <span className="badge badge-danger inline-flex items-center gap-1" title={reasons.join(', ')}>
      <TrendingDown size={12} aria-hidden />{t('releaseWatch.regression')}
    </span>
  )
}

function ReleaseRow({ entry }: Readonly<{ entry: ReleaseWatchEntry }>) {
  const { t, i18n } = useTranslation('decisions')
  const count = (n: number) => formatCount(n, i18n.language)
  const labels = useDisplayLabels()
  const complaints = entry.complaint_deltas
  return (
    <li className="py-3 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-text-strong">{entry.label}</span>
        <span className="badge badge-muted font-mono">{entry.date}</span>
        <RegressionBadge entry={entry} />
        <span className="text-xs text-muted">{t('releaseWatch.afterDays', { days: entry.after.days })}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <SideStats label={t('releaseWatch.before')} side={entry.before} />
        <SideStats label={t('releaseWatch.after')} side={entry.after} />
      </div>
      <TopCategoryShift before={entry.before} after={entry.after} />
      {complaints.length > 0 && (
        <p className="text-sm">
          <span className="text-muted">{t('releaseWatch.complaints')}: </span>
          {complaints.map((row) => `${labels.category(row.name)} (${count(row.before)} → ${count(row.after)})`).join(', ')}
        </p>
      )}
      {entry.evidence.length > 0 && (
        <div className="text-sm space-y-1">
          <p className="text-muted">{t('releaseWatch.evidence')}:</p>
          <ul className="space-y-1">
            {entry.evidence.slice(0, EVIDENCE_SHOWN).map((row, index) => (
              <li key={row.feedbackId} className="min-w-0">
                <ReviewLink feedbackId={row.feedbackId} className="link line-clamp-1 break-words">
                  {row.title === '' ? t('releaseWatch.evidenceItem', { n: index + 1 }) : row.title}
                </ReviewLink>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  )
}

export default function ReleaseWatchList({ releases }: Readonly<{ releases: readonly ReleaseWatchEntry[] }>) {
  const { t } = useTranslation('decisions')
  if (releases.length === 0) return <p className="text-sm text-muted">{t('releaseWatch.empty')}</p>
  return (
    <ul className="divide-y divide-border">
      {releases.map((entry) => <ReleaseRow key={entry.key} entry={entry} />)}
    </ul>
  )
}
