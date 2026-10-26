/**
 * @fileoverview Us against one brand, per category of OUR taxonomy: positive
 * share and volume on both sides, and who is better (GET /radar/brands/{brand}/compare).
 * Their cell opens their reviews in that category (ReviewsModal); ours opens our own
 * Categories page filtered to it. A verdict drawn from fewer than {@link FEW_REVIEWS}
 * reviews on either side carries a "few reviews" caution.
 * @module pages/Radar/CompareTable
 */
import { AlertTriangle, Scale } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import type { ReactNode } from 'react'
import SectionTitle from './SectionTitle'
import { percent } from './radarFormat'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import type { RadarReviewFilter } from '../../api/radarApi'
import type { RadarCompare, RadarCompareRow } from '../../api/radarSchema'

const VERDICT_TONE: Record<NonNullable<RadarCompareRow['verdict']>, string> = {
  they_are_better: 'text-danger',
  we_are_better: 'text-ok',
  even: 'text-muted',
}

function Side({ side }: Readonly<{ side: RadarCompareRow['theirs'] | null }>) {
  const { t, i18n } = useTranslation('radar')
  if (side === null || side.volume === 0) return <span className="text-muted">{t('compare.noData')}</span>
  return (
    <span>
      {t('compare.positive', { value: percent(side.positive_share, i18n.language) })}
      <span className="block text-xs text-muted">{t('compare.volume', { count: side.volume })}</span>
    </span>
  )
}

/** Under this many reviews on either side, a verdict is a hint, not a finding. */
const FEW_REVIEWS = 10

function hasFewReviews(row: RadarCompareRow): boolean {
  return row.theirs.volume < FEW_REVIEWS || (row.ours?.volume ?? 0) < FEW_REVIEWS
}

/** Our side, linking to our Categories page in that category. */
function OurSide({ row, label }: Readonly<{ row: RadarCompareRow; label: string }>) {
  const { t } = useTranslation('radar')
  if (row.ours === null || row.ours.volume === 0) return <Side side={row.ours} />
  return (
    <Link to={`/categories?${new URLSearchParams({ category: row.category }).toString()}`}
      className="block rounded-sm hover:bg-bg-hover hover:text-accent"
      aria-label={t('compare.openOurs', { category: label, count: row.ours.volume })}>
      <Side side={row.ours} />
    </Link>
  )
}

function Verdict({ row }: Readonly<{ row: RadarCompareRow }>) {
  const { t } = useTranslation('radar')
  if (row.verdict === null) return <span className="text-muted">{t('compare.noData')}</span>
  return (
    <span>
      <span className={VERDICT_TONE[row.verdict]}>{t(`compare.${row.verdict}`)}</span>
      {hasFewReviews(row) ? (
        <span className="mt-0.5 flex items-start gap-1 text-xs text-warn">
          <AlertTriangle size={12} aria-hidden="true" className="mt-0.5 shrink-0" />
          <span className="min-w-0">{t('compare.fewReviews', { min: FEW_REVIEWS })}</span>
        </span>
      ) : null}
    </span>
  )
}

function TheirSide({ row, label, onRead }: Readonly<{ row: RadarCompareRow; label: string; onRead: (filter: RadarReviewFilter) => void }>) {
  const { t } = useTranslation('radar')
  if (row.theirs.volume === 0) return <Side side={row.theirs} />
  return (
    <button type="button" className="text-left rounded-sm hover:bg-bg-hover hover:text-accent"
      aria-label={t('reviews.readTheirs', { category: label, count: row.theirs.volume })}
      onClick={() => onRead({ category: row.category })}>
      <Side side={row.theirs} />
    </button>
  )
}

/**
 * Responsive table (WCAG 1.4.10 reflow): a real table while its card is at least 36rem
 * wide (`@xl`, rem-based, so 200 % text switches earlier), below that each row is a stacked
 * card: the category as its heading, then "Them / Us / Verdict" cells that wrap side by side
 * or one per line. Changing a table's `display` drops its semantics in some browsers, so the
 * elements carry their roles explicitly; the column headers stay for assistive technology
 * (visually hidden when stacked), and the visible in-cell labels are `aria-hidden` so a
 * screen reader does not hear each label twice. No cell has a fixed or minimum width.
 */
const COMPARE_LAYOUT = {
  table: 'block w-full text-sm @xl:table',
  head: 'sr-only @xl:not-sr-only @xl:table-header-group',
  headRow: '@xl:table-row text-left text-xs text-muted',
  body: 'block @xl:table-row-group',
  row: 'grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-x-3 gap-y-1 border-t border-border py-2 align-top @xl:table-row @xl:py-0',
  rowHeader: 'col-span-full min-w-0 break-words hyphens-auto font-medium text-text text-left @xl:table-cell @xl:py-2 @xl:pr-3',
  cell: 'min-w-0 break-words hyphens-auto text-text @xl:table-cell @xl:py-2 @xl:pr-3',
  cellLabel: 'block text-xs text-muted @xl:hidden',
}

const COL_HEAD = 'py-2 pr-3 font-medium @xl:table-cell'

function Cell({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <td role="cell" className={COMPARE_LAYOUT.cell}>
      <span aria-hidden="true" className={COMPARE_LAYOUT.cellLabel}>{label}</span>
      {children}
    </td>
  )
}

export default function CompareTable({ compare, onRead }: Readonly<{
  compare: RadarCompare; onRead: (filter: RadarReviewFilter) => void
}>) {
  const { t } = useTranslation('radar')
  const labels = useDisplayLabels()
  return (
    <section className="card @container min-w-0" aria-labelledby="radar-compare">
      <SectionTitle id="radar-compare" icon={Scale}>{t('compare.title')}</SectionTitle>
      {compare.ours_available ? null : <p className="text-xs text-warn mb-2">{t('compare.unavailable')}</p>}
      {compare.categories.length === 0 ? <p className="text-sm text-muted">{t('compare.empty')}</p> : (
        <table role="table" className={COMPARE_LAYOUT.table}>
          <thead role="rowgroup" className={COMPARE_LAYOUT.head}>
            <tr role="row" className={COMPARE_LAYOUT.headRow}>
              <th role="columnheader" scope="col" className={COL_HEAD}>{t('compare.category')}</th>
              <th role="columnheader" scope="col" className={COL_HEAD}>{t('compare.them')}</th>
              <th role="columnheader" scope="col" className={COL_HEAD}>{t('compare.us')}</th>
              <th role="columnheader" scope="col" className={COL_HEAD}>{t('compare.verdict')}</th>
            </tr>
          </thead>
          <tbody role="rowgroup" className={COMPARE_LAYOUT.body}>
            {compare.categories.map((row) => {
              const label = labels.category(row.category)
              return (
                <tr role="row" key={row.category} className={COMPARE_LAYOUT.row}>
                  <th role="rowheader" scope="row" className={COMPARE_LAYOUT.rowHeader}>{label}</th>
                  <Cell label={t('compare.them')}><TheirSide row={row} label={label} onRead={onRead} /></Cell>
                  <Cell label={t('compare.us')}><OurSide row={row} label={label} /></Cell>
                  <Cell label={t('compare.verdict')}><Verdict row={row} /></Cell>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </section>
  )
}
