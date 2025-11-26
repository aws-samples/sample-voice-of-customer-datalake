import type { ReactNode } from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import clsx from 'clsx'

interface MetricCardProps {
  title: string
  value: string | number
  change?: number
  icon?: ReactNode
  trend?: 'up' | 'down' | 'neutral'
  color?: 'blue' | 'green' | 'red' | 'orange' | 'gray'
}

export default function MetricCard({ title, value, change, icon, trend, color = 'blue' }: MetricCardProps) {
  const colorClasses = {
    blue: 'bg-blue-50 text-blue-600',
    green: 'bg-green-50 text-green-600',
    red: 'bg-red-50 text-red-600',
    orange: 'bg-orange-50 text-orange-600',
    gray: 'bg-gray-50 text-gray-600',
  }

  const TrendIcon = trend === 'up' ? TrendingUp : trend === 'down' ? TrendingDown : Minus

  return (
    <div className="card">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500 mb-1">{title}</p>
          <p className="text-2xl font-bold text-gray-900">{value}</p>
          {change !== undefined && (
            <div className={clsx(
              'flex items-center gap-1 mt-2 text-sm',
              trend === 'up' && 'text-green-600',
              trend === 'down' && 'text-red-600',
              trend === 'neutral' && 'text-gray-500'
            )}>
              <TrendIcon size={14} />
              <span>{change > 0 ? '+' : ''}{change}%</span>
            </div>
          )}
        </div>
        {icon && (
          <div className={clsx('p-3 rounded-lg', colorClasses[color])}>
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}
