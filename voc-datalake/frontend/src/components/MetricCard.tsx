/**
 * @fileoverview Dashboard metric card component.
 *
 * Displays a single metric with optional trend indicator:
 * - Title and large value display
 * - Optional icon with color theming
 * - Trend arrow (up/down/neutral) with percentage change
 * - Mobile-responsive with adaptive sizing
 *
 * @module components/MetricCard
 */

import type { ReactNode } from 'react'
import { TrendingUp, TrendingDown, Minus } from 'lucide-react'
import clsx from 'clsx'

interface MetricCardProps {
  /** Metric title/label */
  title: string
  /** Main metric value */
  value: string | number
  /** Percentage change from previous period */
  change?: number
  /** Icon element to display */
  icon?: ReactNode
  /** Trend direction for styling */
  trend?: 'up' | 'down' | 'neutral'
  /** Color theme for icon background */
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
    <div className="card !p-3 sm:!p-4 md:!p-6">
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs sm:text-sm text-gray-500 mb-0.5 sm:mb-1 truncate">{title}</p>
          <p className="text-lg sm:text-xl md:text-2xl font-bold text-gray-900 truncate">{value}</p>
          {change !== undefined && (
            <div 
              className={clsx(
                'inline-flex items-center gap-1 mt-1 sm:mt-2 text-xs sm:text-sm',
                trend === 'up' && 'text-green-600',
                trend === 'down' && 'text-red-600',
                trend === 'neutral' && 'text-gray-500'
              )}
              aria-label={`${trend === 'up' ? 'Increased' : trend === 'down' ? 'Decreased' : 'No change'} by ${Math.abs(change)}%`}
            >
              <TrendIcon size={14} className="flex-shrink-0" aria-hidden="true" />
              <span>{change > 0 ? '+' : ''}{change}%</span>
            </div>
          )}
        </div>
        {icon && (
          <div 
            className={clsx(
              'p-2 sm:p-2.5 md:p-3 rounded-lg flex-shrink-0',
              colorClasses[color]
            )}
            aria-hidden="true"
          >
            {icon}
          </div>
        )}
      </div>
    </div>
  )
}
