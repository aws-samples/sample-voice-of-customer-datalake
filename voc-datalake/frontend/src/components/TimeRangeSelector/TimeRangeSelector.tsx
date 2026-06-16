/**
 * @fileoverview Time range selector dropdown component.
 *
 * Features:
 * - Preset ranges: 24h, 48h, 7d, 30d, 90d (90-day cap, matches aggregates TTL)
 * - Custom "last N days" rolling lookback input
 * - Persists selection to config store
 * - Mobile-responsive dropdown
 * - "Data freshness" caption clarifying the window filters by ingestion date
 *
 * @module components/TimeRangeSelector
 */

import { useState, useRef, useEffect } from 'react'
import { useConfigStore } from '../../store/configStore'
import { Calendar, X, ChevronDown } from 'lucide-react'
import clsx from 'clsx'

const ranges = [
  { value: '24h', label: '24h', fullLabel: '24 Hours' },
  { value: '48h', label: '48h', fullLabel: '48 Hours' },
  { value: '7d', label: '7d', fullLabel: '7 Days' },
  { value: '30d', label: '30d', fullLabel: '30 Days' },
  { value: 'all', label: '90d', fullLabel: '90 Days' },
  { value: 'custom', label: 'Custom', fullLabel: 'Custom' },
] as const

// Explains that the window filters by when feedback entered the data lake
// (ingestion/processing date), not the original review's authored date.
const DATA_FRESHNESS_TOOLTIP = 'Filters by when data was collected, not the original review date.'

// Upper bound for the custom lookback. Capped at 90 days to match the widest
// preset and the aggregates 90-day TTL: the metrics categories/sentiment
// endpoints fan out into `categories × days` sequential DynamoDB calls, which
// exceed API Gateway's 29s timeout beyond ~90 days. Must stay <= the backend
// `validate_days` max (365) so the value is never silently clamped.
const MAX_CUSTOM_DAYS = 90

/** Parse the days input into a valid positive integer, or null when invalid. */
function parseDaysInput(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null
  const n = Number(value.trim())
  if (!Number.isInteger(n) || n < 1 || n > MAX_CUSTOM_DAYS) return null
  return n
}

export default function TimeRangeSelector() {
  const { timeRange, setTimeRange, customDays, setCustomDays } = useConfigStore()
  const [showPicker, setShowPicker] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [daysInput, setDaysInput] = useState(customDays ? String(customDays) : '')
  const pickerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Close picker/dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target
      if (target instanceof Node) {
        if (pickerRef.current && !pickerRef.current.contains(target)) {
          setShowPicker(false)
        }
        if (dropdownRef.current && !dropdownRef.current.contains(target)) {
          setShowDropdown(false)
        }
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleRangeClick = (value: typeof ranges[number]['value']) => {
    if (value === 'custom') {
      setDaysInput(customDays ? String(customDays) : '')
      setShowPicker(true)
      setShowDropdown(false)
    } else {
      setTimeRange(value)
      setCustomDays(null)
      setShowPicker(false)
      setShowDropdown(false)
    }
  }

  const parsedDays = parseDaysInput(daysInput)

  const handleApplyCustom = () => {
    if (parsedDays !== null) {
      setCustomDays(parsedDays)
      setTimeRange('custom')
      setShowPicker(false)
    }
  }

  const handleClearCustom = () => {
    setCustomDays(null)
    setDaysInput('')
    setTimeRange('7d')
    setShowPicker(false)
  }

  const customLabel = customDays ? `Last ${customDays} days` : null

  const getDisplayLabel = () => {
    if (timeRange === 'custom' && customLabel) {
      return customLabel
    }
    return ranges.find(r => r.value === timeRange)?.label || '7d'
  }

  const getCurrentFullLabel = () => {
    if (timeRange === 'custom' && customLabel) {
      return customLabel
    }
    return ranges.find(r => r.value === timeRange)?.fullLabel || '7 Days'
  }

  return (
    <div className="relative flex items-center gap-2">
      <div
        className="hidden sm:flex items-center gap-1.5 text-gray-400"
        title={DATA_FRESHNESS_TOOLTIP}
      >
        <Calendar size={18} aria-hidden="true" />
        <span className="text-xs font-medium text-gray-500 whitespace-nowrap">Data freshness</span>
      </div>
      {/* Mobile: Dropdown selector */}
      <div className="sm:hidden relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="flex items-center gap-2 px-3 py-2.5 bg-gray-100 rounded-lg text-sm text-gray-700 active:bg-gray-200 touch-manipulation min-h-[44px]"
          aria-expanded={showDropdown}
          aria-haspopup="listbox"
          title={DATA_FRESHNESS_TOOLTIP}
        >
          <Calendar size={16} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
          <span className="truncate max-w-[100px]">{getDisplayLabel()}</span>
          <ChevronDown size={16} className={clsx('transition-transform flex-shrink-0', showDropdown && 'rotate-180')} aria-hidden="true" />
        </button>
        
        {showDropdown && (
          <div 
            className="absolute top-full right-0 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50 min-w-[160px]"
            role="listbox"
          >
            {ranges.map(({ value, fullLabel }) => (
              <button
                key={value}
                onClick={() => handleRangeClick(value)}
                role="option"
                aria-selected={timeRange === value}
                className={clsx(
                  'w-full px-4 py-3 text-sm text-left transition-colors touch-manipulation',
                  timeRange === value
                    ? 'bg-blue-50 text-blue-700'
                    : 'text-gray-700 hover:bg-gray-50 active:bg-gray-100'
                )}
              >
                {value === 'custom' && customLabel ? getCurrentFullLabel() : fullLabel}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Desktop: Button group */}
      <div className="hidden sm:flex bg-gray-100 rounded-lg p-1">
        {ranges.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => handleRangeClick(value)}
            className={clsx(
              'px-3 py-1.5 text-sm rounded-md transition-colors whitespace-nowrap',
              timeRange === value
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            )}
          >
            {value === 'custom' && customLabel ? getDisplayLabel() : label}
          </button>
        ))}
      </div>

      {/* Custom "last N days" picker dropdown */}
      {showPicker && (
        <div
          ref={pickerRef}
          className="fixed sm:absolute inset-x-4 sm:inset-x-auto bottom-4 sm:bottom-auto sm:top-full sm:right-0 sm:mt-2 bg-white rounded-xl sm:rounded-lg shadow-xl border border-gray-200 p-4 z-50 sm:w-auto sm:min-w-[280px] sm:max-w-[320px]"
          role="dialog"
          aria-label="Select custom range"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-900">Custom range</h3>
            <button 
              onClick={() => setShowPicker(false)} 
              className="text-gray-400 hover:text-gray-600 p-2 -m-2 touch-manipulation"
              aria-label="Close custom range"
            >
              <X size={20} />
            </button>
          </div>

          <div>
            <label htmlFor="custom-days" className="block text-sm text-gray-600 mb-1.5">
              Last N days
            </label>
            <div className="flex items-center gap-2">
              <input
                id="custom-days"
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_CUSTOM_DAYS}
                value={daysInput}
                onChange={(e) => setDaysInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleApplyCustom() }}
                placeholder="e.g. 14"
                className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-base sm:text-sm"
              />
              <span className="text-sm text-gray-500 whitespace-nowrap">days</span>
            </div>
            <p className="mt-1.5 text-xs text-gray-400">
              Enter a whole number of days (1–{MAX_CUSTOM_DAYS}).
            </p>
          </div>

          <div className="flex items-center justify-between mt-4 pt-4 border-t gap-2">
            {customDays && (
              <button
                onClick={handleClearCustom}
                className="text-sm text-red-600 hover:text-red-700 py-2 touch-manipulation"
              >
                Clear
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button
                onClick={() => setShowPicker(false)}
                className="px-4 py-2.5 sm:py-1.5 text-sm text-gray-600 hover:text-gray-900 touch-manipulation"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyCustom}
                disabled={parsedDays === null}
                className="px-5 py-2.5 sm:py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
              >
                Apply
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
