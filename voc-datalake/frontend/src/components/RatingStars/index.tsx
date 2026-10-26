import { Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'

interface RatingStarsProps {
  readonly rating: number | null
  readonly max?: number
  readonly showLabel?: boolean
  readonly fallback?: React.ReactNode
  /** Star size in px (14 inline with text, 12 in dense meta rows). */
  readonly size?: number
  readonly className?: string
}

/**
 * Read-only star rating. Exposed as one image with a "4 out of 5 stars" name so
 * a screen reader hears the value instead of five unlabeled icons.
 */
export default function RatingStars({
  rating, max = 5, showLabel, fallback = null, size = 14, className,
}: RatingStarsProps) {
  const { t } = useTranslation('components')
  if (rating === null) {
    return <>{fallback}</>
  }

  return (
    <div
      className={clsx('flex items-center gap-0.5', className)}
      role="img"
      aria-label={t('ratingStars.label', { rating, max })}
    >
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          size={size}
          aria-hidden="true"
          className={i < rating ? 'text-warn fill-warn' : 'text-muted-strong'}
        />
      ))}
      {showLabel === true ? <span className="ml-1 text-sm font-mono text-text" aria-hidden="true">{rating}/{max}</span> : null}
    </div>
  )
}
