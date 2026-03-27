import { Star } from 'lucide-react'

interface RatingStarsProps {
  readonly rating: number | null
  readonly max?: number
  readonly showLabel?: boolean
  readonly fallback?: React.ReactNode
}

export default function RatingStars({
  rating, max = 5, showLabel, fallback = null,
}: RatingStarsProps) {
  if (rating === null) {
    // eslint-disable-next-line react/jsx-no-useless-fragment -- consistent return type
    return <>{fallback}</>
  }

  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: max }, (_, i) => (
        <Star
          key={i}
          size={14}
          className={i < rating ? 'text-yellow-400 fill-yellow-400' : 'text-gray-300'}
        />
      ))}
      {showLabel === true ? <span className="ml-1 text-sm text-gray-600">{rating}/{max}</span> : null}
    </div>
  )
}
