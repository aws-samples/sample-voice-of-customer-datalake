import { CalendarClock, Trash2 } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import RatingStars from '../../components/RatingStars'
import type { ParsedReview } from '../../store/manualImportStore'

interface ParsedReviewCardProps {
  readonly review: ParsedReview
  readonly index: number
  readonly onUpdate: (index: number, review: Partial<ParsedReview>) => void
  readonly onDelete: (index: number) => void
}

const RATING_OPTIONS = [
  {
    value: null,
    labelKey: 'parsedReview.noRating',
  },
  {
    value: 1,
    labelKey: 'parsedReview.star',
    count: 1,
  },
  {
    value: 2,
    labelKey: 'parsedReview.star',
    count: 2,
  },
  {
    value: 3,
    labelKey: 'parsedReview.star',
    count: 3,
  },
  {
    value: 4,
    labelKey: 'parsedReview.star',
    count: 4,
  },
  {
    value: 5,
    labelKey: 'parsedReview.star',
    count: 5,
  },
]

export default function ParsedReviewCard({
  review, index, onUpdate, onDelete,
}: ParsedReviewCardProps) {
  const { t } = useTranslation('scrapers')
  const defaultedNoteId = useId()
  const dateMissing = review.date == null || review.date === ''
  return (
    <div className="border border-border rounded-lg p-4 bg-card">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 flex-wrap">
          <RatingStars rating={review.rating} />
          <select
            value={review.rating ?? ''}
            onChange={(e) => onUpdate(index, { rating: e.target.value === '' ? null : Number(e.target.value) })}
            className="select select-sm w-auto"
          >
            {RATING_OPTIONS.map((opt) => (
              <option key={opt.labelKey + (opt.count ?? '')} value={opt.value ?? ''}>
                {opt.count == null ? t(opt.labelKey) : t(opt.labelKey, { count: opt.count })}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={review.author ?? ''}
            onChange={(e) => onUpdate(index, { author: e.target.value === '' ? null : e.target.value })}
            placeholder={t('parsedReview.authorPlaceholder')}
            className="input w-32 px-2 py-1"
          />
          <input
            type="date"
            required
            aria-label={t('parsedReview.dateLabel')}
            aria-invalid={dateMissing}
            aria-describedby={review.date_defaulted === true ? defaultedNoteId : undefined}
            value={review.date ?? ''}
            onChange={(e) => onUpdate(index, { date: e.target.value === '' ? null : e.target.value, date_defaulted: false })}
            className={`input w-auto px-2 py-1 ${dateMissing ? 'border-warn' : ''}`}
          />
          {review.date_defaulted === true && (
            <span id={defaultedNoteId} className="text-xs text-muted flex items-center gap-1">
              <CalendarClock size={14} aria-hidden="true" />
              {t('parsedReview.dateDefaulted')}
            </span>
          )}
        </div>
        <button
          onClick={() => onDelete(index)}
          className="p-1.5 text-danger hover:bg-danger-subtle rounded-sm transition-colors"
          title="Delete review"
        >
          <Trash2 size={16} />
        </button>
      </div>

      <input
        type="text"
        value={review.title ?? ''}
        onChange={(e) => onUpdate(index, { title: e.target.value === '' ? null : e.target.value })}
        placeholder={t('parsedReview.titlePlaceholder')}
        className="input font-medium mb-2"
      />

      <textarea
        value={review.text}
        onChange={(e) => onUpdate(index, { text: e.target.value })}
        placeholder={t('parsedReview.textPlaceholder')}
        rows={3}
        className="input resize-none"
      />
    </div>
  )
}
