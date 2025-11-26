import clsx from 'clsx'

interface SentimentBadgeProps {
  sentiment: string
  score?: number
  size?: 'sm' | 'md'
}

export default function SentimentBadge({ sentiment, score, size = 'sm' }: SentimentBadgeProps) {
  const colors = {
    positive: 'bg-green-100 text-green-800',
    negative: 'bg-red-100 text-red-800',
    neutral: 'bg-gray-100 text-gray-800',
    mixed: 'bg-yellow-100 text-yellow-800',
  }

  return (
    <span className={clsx(
      'inline-flex items-center rounded-full font-medium',
      colors[sentiment as keyof typeof colors] || colors.neutral,
      size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1 text-sm'
    )}>
      {sentiment}
      {score !== undefined && (
        <span className="ml-1 opacity-70">({Number(score).toFixed(2)})</span>
      )}
    </span>
  )
}
