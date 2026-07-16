/**
 * @fileoverview Free-text search + urgent-only toggle for the Categories page.
 * Ported from the removed Feedback page (issue #198).
 * @module pages/Categories/FeedbackSearchBar
 */

import { Search } from 'lucide-react'

interface FeedbackSearchBarProps {
  readonly searchText: string
  readonly onSearchChange: (value: string) => void
  readonly showUrgentOnly: boolean
  readonly onUrgentChange: (value: boolean) => void
}

export function FeedbackSearchBar({
  searchText,
  onSearchChange,
  showUrgentOnly,
  onUrgentChange,
}: FeedbackSearchBarProps) {
  return (
    <div className="card !p-4 sm:!p-6">
      <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={18} />
          <input
            type="text"
            placeholder="Search feedback..."
            value={searchText}
            onChange={(e) => onSearchChange(e.target.value)}
            className="input !pl-11"
          />
        </div>
        <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
          <input
            type="checkbox"
            checked={showUrgentOnly}
            onChange={(e) => onUrgentChange(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-700">Urgent only</span>
        </label>
      </div>
    </div>
  )
}
