import { useState, useRef, useEffect } from 'react'
import { useConfigStore } from '../store/configStore'
import { Calendar, X } from 'lucide-react'
import { format } from 'date-fns'
import clsx from 'clsx'

const ranges = [
  { value: '24h', label: '24 Hours' },
  { value: '48h', label: '48 Hours' },
  { value: '7d', label: '7 Days' },
  { value: '30d', label: '30 Days' },
  { value: 'custom', label: 'Custom' },
] as const

export default function TimeRangeSelector() {
  const { timeRange, setTimeRange, customDateRange, setCustomDateRange } = useConfigStore()
  const [showPicker, setShowPicker] = useState(false)
  const [startDate, setStartDate] = useState(customDateRange?.start || '')
  const [endDate, setEndDate] = useState(customDateRange?.end || '')
  const pickerRef = useRef<HTMLDivElement>(null)

  // Close picker when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowPicker(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleRangeClick = (value: typeof ranges[number]['value']) => {
    if (value === 'custom') {
      setShowPicker(true)
    } else {
      setTimeRange(value)
      setCustomDateRange(null)
      setShowPicker(false)
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
    return null
  }

  return (
    <div className="relative flex items-center gap-2">
      <Calendar size={18} className="text-gray-400" />
      <div className="flex bg-gray-100 rounded-lg p-1">
        {ranges.map(({ value, label }) => (
          <button
            key={value}
            onClick={() => handleRangeClick(value)}
            className={clsx(
              'px-3 py-1.5 text-sm rounded-md transition-colors',
              timeRange === value
                ? 'bg-white text-gray-900 shadow-sm'
                : 'text-gray-600 hover:text-gray-900'
            )}
          >
            {value === 'custom' && customDateRange ? getDisplayLabel() : label}
          </button>
        ))}
      </div>

      {/* Custom Date Picker Dropdown */}
      {showPicker && (
        <div
          ref={pickerRef}
          className="absolute top-full right-0 mt-2 bg-white rounded-lg shadow-xl border border-gray-200 p-4 z-50 min-w-[300px]"
        >
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-medium text-gray-900">Select Date Range</h3>
            <button onClick={() => setShowPicker(false)} className="text-gray-400 hover:text-gray-600">
              <X size={18} />
            </button>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                max={endDate || undefined}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                min={startDate || undefined}
                max={format(new Date(), 'yyyy-MM-dd')}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-between mt-4 pt-4 border-t">
            {customDateRange && (
              <button
                onClick={handleClearCustom}
                className="text-sm text-red-600 hover:text-red-700"
              >
                Clear
              </button>
            )}
            <div className="flex gap-2 ml-auto">
              <button
                onClick={() => setShowPicker(false)}
                className="px-3 py-1.5 text-sm text-gray-600 hover:text-gray-900"
              >
                Cancel
              </button>
              <button
                onClick={handleApplyCustom}
                disabled={!startDate || !endDate}
                className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
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
