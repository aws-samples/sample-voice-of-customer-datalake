/**
 * Filter and control bar for the Problem Analysis page.
 */
import { Filter, X, Eye, EyeOff, FileDown } from 'lucide-react'

interface ProblemFiltersProps {
  readonly allSources: string[]
  readonly allCategories: string[]
  readonly allSubcategories: string[]
  readonly selectedSource: string | null
  readonly selectedCategory: string | null
  readonly selectedSubcategory: string | null
  readonly showUrgentOnly: boolean
  readonly showResolved: boolean
  readonly resolvedCount: number
  readonly similarityThreshold: number
  readonly hasData: boolean
  readonly onSourceChange: (source: string | null) => void
  readonly onCategoryChange: (category: string | null) => void
  readonly onSubcategoryChange: (subcategory: string | null) => void
  readonly onUrgentOnlyChange: (value: boolean) => void
  readonly onShowResolvedChange: (value: boolean) => void
  readonly onSimilarityChange: (value: number) => void
  readonly onExpandAll: () => void
  readonly onCollapseAll: () => void
  readonly onExportPDF: () => void
}

export function ProblemFilters({
  allSources, allCategories, allSubcategories,
  selectedSource, selectedCategory, selectedSubcategory,
  showUrgentOnly, showResolved, resolvedCount, similarityThreshold,
  hasData,
  onSourceChange, onCategoryChange, onSubcategoryChange,
  onUrgentOnlyChange, onShowResolvedChange, onSimilarityChange,
  onExpandAll, onCollapseAll, onExportPDF,
}: ProblemFiltersProps) {
  const hasActiveFilters = selectedSource || selectedCategory || selectedSubcategory || showUrgentOnly

  const clearFilters = () => {
    onSourceChange(null)
    onCategoryChange(null)
    onSubcategoryChange(null)
    onUrgentOnlyChange(false)
  }

  return (
    <div className="card">
      <div className="flex flex-col gap-3 sm:gap-4">
        {/* Filter Row */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <Filter size={16} className="text-gray-500 flex-shrink-0 sm:w-[18px] sm:h-[18px]" />
          <select
            value={selectedSource || ''}
            onChange={(e) => onSourceChange(e.target.value || null)}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
          >
            <option value="">All Sources</option>
            {allSources.map(source => (
              <option key={source} value={source}>{source}</option>
            ))}
          </select>
          <select
            value={selectedCategory || ''}
            onChange={(e) => { onCategoryChange(e.target.value || null); onSubcategoryChange(null) }}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
          >
            <option value="">All Categories</option>
            {allCategories.map(cat => (
              <option key={cat} value={cat}>{cat.replace('_', ' ')}</option>
            ))}
          </select>
          <select
            value={selectedSubcategory || ''}
            onChange={(e) => onSubcategoryChange(e.target.value || null)}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
          >
            <option value="">All Subcategories</option>
            {allSubcategories.map(sub => (
              <option key={sub} value={sub}>{sub.replace('_', ' ')}</option>
            ))}
          </select>
        </div>

        {/* Controls Row */}
        <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <label className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
              <input
                type="checkbox"
                checked={showUrgentOnly}
                onChange={(e) => onUrgentOnlyChange(e.target.checked)}
                className="rounded border-gray-300 w-3.5 h-3.5 sm:w-4 sm:h-4"
              />
              <span>Urgent only</span>
            </label>
            <label className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
              <input
                type="checkbox"
                checked={showResolved}
                onChange={(e) => onShowResolvedChange(e.target.checked)}
                className="rounded border-gray-300 w-3.5 h-3.5 sm:w-4 sm:h-4"
              />
              {showResolved ? (
                <Eye size={14} className="text-gray-500 sm:w-4 sm:h-4" />
              ) : (
                <EyeOff size={14} className="text-gray-400 sm:w-4 sm:h-4" />
              )}
              <span>Show resolved</span>
              {resolvedCount > 0 && (
                <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">
                  {resolvedCount}
                </span>
              )}
            </label>
            {hasActiveFilters && (
              <button
                onClick={clearFilters}
                className="text-xs sm:text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 active:scale-95"
              >
                <X size={12} className="sm:w-[14px] sm:h-[14px]" />
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
              <span className="text-gray-500 hidden xs:inline">Similarity:</span>
              <select
                value={similarityThreshold}
                onChange={(e) => onSimilarityChange(parseFloat(e.target.value))}
                className="px-2 py-1 border border-gray-300 rounded text-xs sm:text-sm"
                title="Higher = stricter matching, fewer merged groups"
              >
                <option value={0.2}>Low</option>
                <option value={0.4}>Med</option>
                <option value={0.6}>High</option>
                <option value={1.0}>Off</option>
              </select>
            </div>
            <div className="flex gap-1.5 sm:gap-2">
              <button onClick={onExpandAll} className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95">
                <span className="hidden xs:inline">Expand All</span>
                <span className="xs:hidden">Expand</span>
              </button>
              <button onClick={onCollapseAll} className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95">
                <span className="hidden xs:inline">Collapse All</span>
                <span className="xs:hidden">Collapse</span>
              </button>
              {hasData && (
                <button
                  onClick={onExportPDF}
                  className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95 flex items-center gap-1"
                  title="Export as PDF"
                >
                  <FileDown size={14} />
                  <span className="hidden xs:inline">PDF</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
