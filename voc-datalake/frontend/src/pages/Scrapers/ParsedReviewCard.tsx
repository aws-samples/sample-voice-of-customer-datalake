import { Trash2, Star } from 'lucide-react'
import type { ParsedReview } from '../../store/manualImportStore'

interface ParsedReviewCardProps {
  readonly review: ParsedReview
  readonly index: number
  readonly onUpdate: (index: number, review: Partial<ParsedReview>) => void
  readonly onDelete: (index: number) => void
}

const RATING_OPTIONS = [
  { value: null, label: 'No rating' },
  { value: 1, label: '1 star' },
  { value: 2, label: '2 stars' },
  { value: 3, label: '3 stars' },
  { value: 4, label: '4 stars' },
  { value: 5, label: '5 stars' },
]

function RatingStars({ rating }: { readonly rating: number | null }) {
  if (rating === null) return null
  return (
    <div className="flex items-center gap-0.5">
      {[1, 2, 3, 4, 5].map((star) => (
        <Star
          key={star}
          size={14}
          className={star <= rating ? 'fill-yellow-400 text-yellow-400' : 'text-gray-300'}
        />
      ))}
    </div>
  )
}

export default function ParsedReviewCard({ review, index, onUpdate, onDelete }: ParsedReviewCardProps) {
  return (
    <div className="border border-gray-200 rounded-lg p-4 bg-white">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3 flex-wrap">
          <RatingStars rating={review.rating} />
          <select
            value={review.rating ?? ''}
            onChange={(e) => onUpdate(index, { rating: e.target.value ? Number(e.target.value) : null })}
            className="text-sm border border-gray-200 rounded px-2 py-1"
          >
            {RATING_OPTIONS.map((opt) => (
              <option key={opt.label} value={opt.value ?? ''}>
                {opt.label}
              </option>
            ))}
          </select>
          <input
            type="text"
            value={review.author ?? ''}
            onChange={(e) => onUpdate(index, { author: e.target.value || null })}
            placeholder="Author"
            className="text-sm border border-gray-200 rounded px-2 py-1 w-32"
          />
          <input
            type="date"
            value={review.date ?? ''}
            onChange={(e) => onUpdate(index, { date: e.target.value || null })}
            className="text-sm border border-gray-200 rounded px-2 py-1"
          />
        </div>
        <button
          onClick={() => onDelete(index)}
          className="p-1.5 text-red-500 hover:bg-red-50 rounded transition-colors"
          title="Delete review"
        >
          <Trash2 size={16} />
        </button>
      </div>
      
      <input
        type="text"
        value={review.title ?? ''}
        onChange={(e) => onUpdate(index, { title: e.target.value || null })}
        placeholder="Review title (optional)"
        className="w-full text-sm font-medium border border-gray-200 rounded px-3 py-2 mb-2"
      />
      
      <textarea
        value={review.text}
        onChange={(e) => onUpdate(index, { text: e.target.value })}
        placeholder="Review text"
        rows={3}
        className="w-full text-sm border border-gray-200 rounded px-3 py-2 resize-none"
      />
    </div>
  )
}
