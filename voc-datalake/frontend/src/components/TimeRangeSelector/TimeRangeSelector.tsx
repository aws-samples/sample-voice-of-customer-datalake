/**
 * @fileoverview Time range selector dropdown component.
 *
 * Features:
 * - Preset ranges: 24h, 48h, 7d, 30d, 90d (90-day cap, matches aggregates TTL)
 * - Custom "last N days" rolling lookback input
 * - Date-basis picker: filter by imported date (when data was collected) or
 *   review date (when the customer originally wrote the feedback)
 * - Persists selection to config store
 * - Mobile-responsive dropdown
 *
 * @module components/TimeRangeSelector
 */

import { useState, useRef, useEffect } from 'react'
import { useConfigStore } from '../../store/configStore'
import type { DateBasis } from '../../api/types'
import { Calendar, X, ChevronDown, Check } from 'lucide-react'
import clsx from 'clsx'

const ranges = [
  { value: '24h', label: '24h', fullLabel: '24 Hours' },
  { value: '48h', label: '48h', fullLabel: '48 Hours' },
  { value: '7d', label: '7d', fullLabel: '7 Days' },
  { value: '30d', label: '30d', fullLabel: '30 Days' },
  { value: 'all', label: '90d', fullLabel: '90 Days' },
  { value: 'custom', label: 'Custom', fullLabel: 'Custom' },
] as const

// The two dates every feedback item carries. The time range window applies to
// whichever one is selected here.
const DATE_BASIS_OPTIONS: ReadonlyArray<{
  value: DateBasis
  label: string
  description: string
}> = [
  {
    value: 'imported',
    label: 'Imported date',
    description: 'When the feedback was collected into the platform.',
  },
  {
    value: 'review',
    label: 'Review date',
    description: 'When the customer originally wrote the feedback.',
  },
]

// Tooltip clarifying which date the current window filters by.
const BASIS_TOOLTIPS: Record<DateBasis, string> = {
  imported: 'Filtering by when data was collected, not when the review was written.',
  review: 'Filtering by when the review was written, not when it was imported.',
}

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
  const { timeRange, setTimeRange, customDays, setCustomDays, dateBasis, setDateBasis } = useConfigStore()
  const [showPicker, setShowPicker] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [showBasisPicker, setShowBasisPicker] = useState(false)
  const [daysInput, setDaysInput] = useState(customDays ? String(customDays) : '')
  const pickerRef = useRef<HTMLDivElement>(null)
  const dropdownRef = useRef<HTMLDivElement>(null)
  const basisRef = useRef<HTMLDivElement>(null)

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
        if (basisRef.current && !basisRef.current.contains(target)) {
          setShowBasisPicker(false)
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

  const handleBasisSelect = (basis: DateBasis) => {
    setDateBasis(basis)
    setShowBasisPicker(false)
    setShowDropdown(false)
  }

  const currentBasis = DATE_BASIS_OPTIONS.find(o => o.value === dateBasis) ?? DATE_BASIS_OPTIONS[0]
  const basisTooltip = BASIS_TOOLTIPS[currentBasis.value]

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
      {/* Desktop: date-basis picker (imported date vs review date) */}
      <div className="hidden sm:block relative" ref={basisRef}>
        <button
          onClick={() => setShowBasisPicker(!showBasisPicker)}
          className="flex items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 rounded-lg hover:bg-gray-100 transition-colors"
          title={basisTooltip}
          aria-expanded={showBasisPicker}
          aria-haspopup="listbox"
          aria-label={`Filter dates by: ${currentBasis.label}`}
        >
          <Calendar size={16} aria-hidden="true" />
          <span className="whitespace-nowrap">{currentBasis.label}</span>
          <ChevronDown
            size={14}
            className={clsx('transition-transform', showBasisPicker && 'rotate-180')}
            aria-hidden="true"
          />
        </button>

        {showBasisPicker && (
          <div
            className="absolute top-full left-0 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50 w-72"
            role="listbox"
            aria-label="Filter dates by"
          >
            <p className="px-4 pt-2 pb-1 text-[11px] font-medium uppercase tracking-wide text-gray-400">
              Filter dates by
            </p>
            {DATE_BASIS_OPTIONS.map(({ value, label, description }) => (
              <button
                key={value}
                onClick={() => handleBasisSelect(value)}
                role="option"
                aria-selected={dateBasis === value}
                className={clsx(
                  'w-full px-4 py-2.5 text-left transition-colors',
                  dateBasis === value ? 'bg-blue-50' : 'hover:bg-gray-50'
                )}
              >
                <span className="flex items-start justify-between gap-2">
                  <span>
                    <span className={clsx(
                      'block text-sm font-medium',
                      dateBasis === value ? 'text-blue-700' : 'text-gray-900'
                    )}>
                      {label}
                    </span>
                    <span className="block text-xs text-gray-500 mt-0.5">{description}</span>
                  </span>
                  {dateBasis === value && (
                    <Check size={16} className="text-blue-600 flex-shrink-0 mt-0.5" aria-hidden="true" />
                  )}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
      {/* Mobile: Dropdown selector */}
      <div className="sm:hidden relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="flex items-center gap-2 px-3 py-2.5 bg-gray-100 rounded-lg text-sm text-gray-700 active:bg-gray-200 touch-manipulation min-h-[44px]"
          aria-expanded={showDropdown}
          aria-haspopup="listbox"
          title={basisTooltip}
        >
          <Calendar size={16} className="text-gray-400 flex-shrink-0" aria-hidden="true" />
          <span className="truncate max-w-[100px]">{getDisplayLabel()}</span>
          <ChevronDown size={16} className={clsx('transition-transform flex-shrink-0', showDropdown && 'rotate-180')} aria-hidden="true" />
        </button>
        
        {showDropdown && (
          <div 
            className="absolute top-full right-0 mt-1 bg-white rounded-lg shadow-xl border border-gray-200 py-1 z-50 min-w-[200px]"
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
            {/* Date-basis section (imported date vs review date) */}
            <div className="border-t border-gray-100 mt-1 pt-1" role="group" aria-label="Filter dates by">
              <p className="px-4 pt-1 pb-0.5 text-[11px] font-medium uppercase tracking-wide text-gray-400">
                Filter dates by
              </p>
              {DATE_BASIS_OPTIONS.map(({ value, label }) => (
                <button
                  key={value}
                  onClick={() => handleBasisSelect(value)}
                  aria-pressed={dateBasis === value}
                  className={clsx(
                    'w-full px-4 py-3 text-sm text-left transition-colors touch-manipulation flex items-center justify-between gap-2',
                    dateBasis === value
                      ? 'bg-blue-50 text-blue-700'
                      : 'text-gray-700 hover:bg-gray-50 active:bg-gray-100'
                  )}
                >
                  {label}
                  {dateBasis === value && <Check size={16} className="flex-shrink-0" aria-hidden="true" />}
                </button>
              ))}
            </div>
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
