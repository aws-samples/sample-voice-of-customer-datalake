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

type TrendDirection = 'up' | 'down' | 'neutral'
type ColorTheme = 'blue' | 'green' | 'red' | 'orange' | 'gray'

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
  trend?: TrendDirection
  /** Color theme for icon background */
  color?: ColorTheme
}

const COLOR_CLASSES: Record<ColorTheme, string> = {
  blue: 'bg-blue-50 text-blue-600',
  green: 'bg-green-50 text-green-600',
  red: 'bg-red-50 text-red-600',
  orange: 'bg-orange-50 text-orange-600',
  gray: 'bg-gray-50 text-gray-600',
}

function getTrendDirection(trend?: TrendDirection): string {
  if (trend === 'up') return 'Increased'
  if (trend === 'down') return 'Decreased'
  return 'No change'
}

function getTrendLabel(trend?: TrendDirection, change?: number): string {
  const direction = getTrendDirection(trend)
  return `${direction} by ${Math.abs(change ?? 0)}%`
}

function getTrendClasses(trend?: TrendDirection): string {
  if (trend === 'up') return 'text-green-600'
  if (trend === 'down') return 'text-red-600'
  return 'text-gray-500'
}

// Render the appropriate trend icon based on direction
function TrendIcon({ trend }: Readonly<{ trend?: TrendDirection }>) {
  if (trend === 'up') return <TrendingUp size={14} className="flex-shrink-0" aria-hidden="true" />
  if (trend === 'down') return <TrendingDown size={14} className="flex-shrink-0" aria-hidden="true" />
  return <Minus size={14} className="flex-shrink-0" aria-hidden="true" />
}

// Trend indicator sub-component - defined outside render to avoid recreation
function TrendIndicator({ trend, change }: Readonly<{ trend?: TrendDirection; change: number }>) {
  return (
    <div 
      className={clsx(
        'inline-flex items-center gap-1 mt-1 sm:mt-2 text-xs sm:text-sm',
        getTrendClasses(trend)
      )}
      aria-label={getTrendLabel(trend, change)}
    >
      <TrendIcon trend={trend} />
      <span>{change > 0 ? '+' : ''}{change}%</span>
    </div>
  )
}

export default function MetricCard({ title, value, change, icon, trend, color = 'blue' }: Readonly<MetricCardProps>) {
  return (
    <div className="card !p-3 sm:!p-4 md:!p-6">
      <div className="flex items-start justify-between gap-2 sm:gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-xs sm:text-sm text-gray-500 mb-0.5 sm:mb-1 truncate">{title}</p>
          <p className="text-lg sm:text-xl md:text-2xl font-bold text-gray-900 truncate">{value}</p>
          {change !== undefined && (
            <TrendIndicator trend={trend} change={change} />
          )}
        </div>
        {icon && (
          <div 
            className={clsx(
              'p-2 sm:p-2.5 md:p-3 rounded-lg flex-shrink-0',
              COLOR_CLASSES[color]
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
