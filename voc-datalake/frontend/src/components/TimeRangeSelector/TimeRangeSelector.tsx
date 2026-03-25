/**
 * @fileoverview Time range selector dropdown component.
 *
 * Features:
 * - Preset ranges: 24h, 48h, 7d, 30d
 * - Custom date range picker
 * - Persists selection to config store
 * - Mobile-responsive dropdown
 *
 * @module components/TimeRangeSelector
 */

import { useState, useRef, useEffect } from 'react'
import { useConfigStore } from '../../store/configStore'
import { Calendar, X, ChevronDown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { format } from 'date-fns'
import clsx from 'clsx'

const rangeValues = ['24h', '48h', '7d', '30d', 'custom'] as const

export default function TimeRangeSelector() {
  const { timeRange, setTimeRange, customDateRange, setCustomDateRange } = useConfigStore()
  const { t } = useTranslation()
  const [showPicker, setShowPicker] = useState(false)
  const [showDropdown, setShowDropdown] = useState(false)
  const [startDate, setStartDate] = useState(customDateRange?.start || '')
  const [endDate, setEndDate] = useState(customDateRange?.end || '')
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

  const handleRangeClick = (value: typeof rangeValues[number]) => {
    if (value === 'custom') {
      setShowPicker(true)
      setShowDropdown(false)
    } else {
      setTimeRange(value)
      setCustomDateRange(null)
      setShowPicker(false)
      setShowDropdown(false)
    }
  }

  const handleApplyCustom = () => {
    if (startDate && endDate) {
      setCustomDateRange({ start: startDate, end: endDate })
      setTimeRange('custom')
      setShowPicker(false)
    }
  }

  const handleClearCustom = () => {
    setCustomDateRange(null)
    setStartDate('')
    setEndDate('')
    setTimeRange('7d')
  }

  const getDisplayLabel = () => {
    if (timeRange === 'custom' && customDateRange) {
      return `${format(new Date(customDateRange.start), 'MMM d')} - ${format(new Date(customDateRange.end), 'MMM d')}`
    }
    return t(`timeRange.${timeRange}`)
  }

  const getCurrentFullLabel = () => {
    if (timeRange === 'custom' && customDateRange) {
      return `${format(new Date(customDateRange.start), 'MMM d')} - ${format(new Date(customDateRange.end), 'MMM d')}`
    }
    return t(`timeRange.${timeRange}Full`)
  }

  return (
    <div className="relative flex items-center gap-2">
      <Calendar size={18} className="text-gray-400 hidden sm:block" />
      
      {/* Mobile: Dropdown selector */}
      <div className="sm:hidden relative" ref={dropdownRef}>
        <button
          onClick={() => setShowDropdown(!showDropdown)}
          className="flex items-center gap-2 px-3 py-2.5 bg-gray-100 rounded-lg text-sm text-gray-700 active:bg-gray-200 touch-manipulation min-h-[44px]"
          aria-expanded={showDropdown}
          aria-haspopup="listbox"
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
            {rangeValues.map((value) => (
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
                {value === 'custom' && customDateRange ? getCurrentFullLabel() : t(`timeRange.${value}Full`)}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Desktop: Button group */}
      <div className="hidden sm:flex bg-gray-100 rounded-lg p-1">
        {rangeValues.map((value) => (
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
            {value === 'custom' && customDateRange ? getDisplayLabel() : t(`timeRange.${value}`)}
          </button>
        ))}
      </div>

      {/* Custom Date Picker Dropdown */}
      {showPicker && (
        <div
          ref={pickerRef}
          className="fixed sm:absolute inset-x-4 sm:inset-x-auto bottom-4 sm:bottom-auto sm:top-full sm:right-0 sm:mt-2 bg-white rounded-xl sm:rounded-lg shadow-xl border border-gray-200 p-4 z-50 sm:w-auto sm:min-w-[300px] sm:max-w-[320px]"
          role="dialog"
          aria-label="Select custom date range"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-900">{t('timeRange.selectDateRange')}</h3>
            <button 
              onClick={() => setShowPicker(false)} 
              className="text-gray-400 hover:text-gray-600 p-2 -m-2 touch-manipulation"
              aria-label="Close date picker"
            >
              <X size={20} />
            </button>
          </div>

          <div className="space-y-4">
            <div>
              <label htmlFor="start-date" className="block text-sm text-gray-600 mb-1.5">{t('timeRange.startDate')}</label>
              <input
                id="start-date"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                max={endDate || undefined}
                className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-base sm:text-sm"
              />
            </div>
            <div>
              <label htmlFor="end-date" className="block text-sm text-gray-600 mb-1.5">{t('timeRange.endDate')}</label>
              <input
                id="end-date"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate || undefined}
                max={format(new Date(), 'yyyy-MM-dd')}
                className="w-full px-3 py-2.5 sm:py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-base sm:text-sm"
              />
            </div>
          </div>

          <div className="flex items-center justify-between mt-4 pt-4 border-t gap-2">
            {customDateRange && (
              <button
                onClick={handleClearCustom}
                className="text-sm text-red-600 hover:text-red-700 py-2 touch-manipulation"
              >
                {t('timeRange.clear')}
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button
                onClick={() => setShowPicker(false)}
                className="px-4 py-2.5 sm:py-1.5 text-sm text-gray-600 hover:text-gray-900 touch-manipulation"
              >
                {t('timeRange.cancel')}
              </button>
              <button
                onClick={handleApplyCustom}
                disabled={!startDate || !endDate}
                className="px-5 py-2.5 sm:py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 active:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed touch-manipulation"
              >
                {t('timeRange.apply')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
