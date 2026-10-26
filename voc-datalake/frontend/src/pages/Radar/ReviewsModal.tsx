/**
 * @fileoverview "<brand> reviews": read the reviews behind a Radar theme, quote, day or
 * category (GET /radar/brands/{brand}/reviews, docs/radar.md). The opener's filter shows as
 * chips that clear one by one; a sentiment select narrows further; "Load more" follows the
 * server's cursor. ModalShell owns the dialog semantics (focus trap, Escape, labelling).
 * @module pages/Radar/ReviewsModal
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { radarApi, radarKeys } from '../../api/radarApi'
import { RADAR_SENTIMENTS } from '../../api/radarSchema'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import ModalShell from '../../components/ModalShell/ModalShell'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import ReviewCard from './ReviewCard'
import { reviewChips, withoutChip } from './reviewFilter'
import { formatCalendarDay } from '../../utils/dateUtils'
import type { RadarReviewFilter } from '../../api/radarApi'
import type { RadarSentiment } from '../../api/radarSchema'
import type { ReviewChipKey } from './reviewFilter'

interface ReviewsModalProps {
  readonly brand: { readonly key: string; readonly label: string }
  readonly days: number
  readonly initialFilter: RadarReviewFilter
  readonly onClose: () => void
}

const isSentiment = (value: string): value is RadarSentiment => RADAR_SENTIMENTS.some((label) => label === value)

function Chips({ filter, onClear }: Readonly<{ filter: RadarReviewFilter; onClear: (key: ReviewChipKey) => void }>) {
  const { t, i18n } = useTranslation('radar')
  const labels = useDisplayLabels()
  const chips = reviewChips(filter)
  if (chips.length === 0) return null
  const shown = (key: ReviewChipKey, value: string) => {
    if (key === 'subcategory') return labels.subcategory(value, filter.category)
    if (key === 'category') return labels.category(value)
    if (key === 'day') return formatCalendarDay(value, i18n.language)
    // Only the sentiment chip is left.
    return isSentiment(value) ? t(`reviews.sentiments.${value}`) : value
  }
  // "No subcategory" is a chip of its own, not "Subcategory: none".
  const chipLabel = (key: ReviewChipKey, value: string) =>
    key === 'subcategory' && value === '' ? t('reviews.noSubcategoryChip') : t(`reviews.chip.${key}`, { value: shown(key, value) })
  return (
    <ul className="flex flex-wrap gap-2" aria-label={t('reviews.filters')}>
      {chips.map(({ key, value }) => {
        const label = chipLabel(key, value)
        return (
          <li key={key} className="badge-muted inline-flex items-center gap-1">
            {label}
            <button type="button" className="btn btn-ghost btn-sm p-0.5" aria-label={t('reviews.clearChip', { label })}
              onClick={() => onClear(key)}>
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        )
      })}
    </ul>
  )
}

function SentimentSelect({ value, onChange }: Readonly<{ value: RadarSentiment | undefined; onChange: (next: RadarSentiment | undefined) => void }>) {
  const { t } = useTranslation('radar')
  const id = useId()
  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{t('reviews.sentimentLabel')}</label>
      <select id={id} className="select w-auto" value={value ?? ''}
        onChange={(e) => onChange(isSentiment(e.target.value) ? e.target.value : undefined)}>
        <option value="">{t('reviews.anySentiment')}</option>
        {RADAR_SENTIMENTS.map((label) => <option key={label} value={label}>{t(`reviews.sentiments.${label}`)}</option>)}
      </select>
    </div>
  )
}

function useReviews(brand: string, days: number, filter: RadarReviewFilter) {
  return useInfiniteQuery({
    queryKey: radarKeys.reviews(brand, days, filter),
    // '' = the first page (no cursor); typed as string without an assertion.
    queryFn: ({ pageParam }) => radarApi.getReviews(brand, days, filter, pageParam === '' ? undefined : pageParam),
    initialPageParam: '',
    getNextPageParam: (last) => last.next_cursor ?? undefined,
  })
}

function ReviewList({ brand, days, filter }: Readonly<{ brand: string; days: number; filter: RadarReviewFilter }>) {
  const { t } = useTranslation('radar')
  const query = useReviews(brand, days, filter)
  if (query.isLoading) return <p className="text-sm text-muted" role="status">{t('reviews.loading')}</p>
  if (query.isError) {
    return <LoadFailed message={t('reviews.loadFailed')} onRetry={() => { void query.refetch() }} retrying={query.isFetching} />
  }
  const reviews = (query.data?.pages ?? []).flatMap((page) => page.reviews)
  return (
    <>
      {reviews.length === 0 ? (
        <p className="text-sm text-muted">{query.hasNextPage ? t('reviews.keepLooking') : t('reviews.empty')}</p>
      ) : (
        <ul className="space-y-3" aria-label={t('reviews.listLabel')}>
          {reviews.map((review) => <ReviewCard key={review.feedback_id} review={review} brand={brand} />)}
        </ul>
      )}
      {query.hasNextPage ? (
        <button type="button" className="btn btn-secondary btn-sm" disabled={query.isFetchingNextPage}
          onClick={() => { void query.fetchNextPage() }}>
          {query.isFetchingNextPage ? t('reviews.loadingMore') : t('reviews.loadMore')}
        </button>
      ) : null}
    </>
  )
}

export default function ReviewsModal({ brand, days, initialFilter, onClose }: ReviewsModalProps) {
  const { t } = useTranslation('radar')
  const titleId = useId()
  const [filter, setFilter] = useState<RadarReviewFilter>(initialFilter)
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="max-w-2xl max-h-[85vh] flex flex-col">
      <div className="flex items-start justify-between gap-3 p-4 border-b border-border">
        <h2 id={titleId} className="text-lg font-semibold text-text-strong">{t('reviews.title', { brand: brand.label })}</h2>
        <button type="button" className="btn btn-ghost btn-sm" aria-label={t('reviews.close')} onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      <div className="p-4 space-y-3 overflow-y-auto">
        <div className="flex flex-wrap items-end gap-3">
          <SentimentSelect value={filter.sentiment} onChange={(sentiment) => setFilter({ ...filter, sentiment })} />
          <Chips filter={filter} onClear={(key) => setFilter(withoutChip(filter, key))} />
        </div>
        <ReviewList brand={brand.key} days={days} filter={filter} />
      </div>
    </ModalShell>
  )
}
