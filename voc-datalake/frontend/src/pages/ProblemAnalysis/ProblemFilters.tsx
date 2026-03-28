/**
 * Filter and control bar for the Problem Analysis page.
 */
import {
  Filter, X, Eye, EyeOff, FileDown,
} from 'lucide-react'
import { useTranslation } from 'react-i18next'

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

interface ControlsRowProps {
  readonly showUrgentOnly: boolean
  readonly showResolved: boolean
  readonly resolvedCount: number
  readonly similarityThreshold: number
  readonly hasData: boolean
  readonly hasActiveFilters: boolean
  readonly onUrgentOnlyChange: (value: boolean) => void
  readonly onShowResolvedChange: (value: boolean) => void
  readonly onSimilarityChange: (value: number) => void
  readonly onExpandAll: () => void
  readonly onCollapseAll: () => void
  readonly onExportPDF: () => void
  readonly onClearFilters: () => void
}

function ControlsRow({
  showUrgentOnly, showResolved, resolvedCount, similarityThreshold,
  hasData, hasActiveFilters,
  onUrgentOnlyChange, onShowResolvedChange, onSimilarityChange,
  onExpandAll, onCollapseAll, onExportPDF, onClearFilters,
}: ControlsRowProps) {
  const { t } = useTranslation('problemAnalysis')

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        <label className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
          <input
            type="checkbox"
            checked={showUrgentOnly}
            onChange={(e) => onUrgentOnlyChange(e.target.checked)}
            className="rounded border-gray-300 w-3.5 h-3.5 sm:w-4 sm:h-4"
          />
          <span>{t('filters.urgentOnly')}</span>
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
          <span>{t('filters.showResolved')}</span>
          {resolvedCount > 0 && (
            <span className="px-1.5 py-0.5 bg-green-100 text-green-700 text-xs rounded-full">
              {resolvedCount}
            </span>
          )}
        </label>
        {hasActiveFilters ? <button
          onClick={onClearFilters}
          className="text-xs sm:text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 active:scale-95"
        >
          <X size={12} className="sm:w-[14px] sm:h-[14px]" />
          {t('filters.clear')}
        </button> : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:gap-4">
        <div className="flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm">
          <span className="text-gray-500 hidden xs:inline">{t('filters.similarity')}</span>
          <select
            value={similarityThreshold}
            onChange={(e) => onSimilarityChange(Number.parseFloat(e.target.value))}
            className="px-2 py-1 border border-gray-300 rounded text-xs sm:text-sm"
            title="Higher = stricter matching, fewer merged groups"
          >
            <option value={0.2}>{t('filters.similarityLow')}</option>
            <option value={0.4}>{t('filters.similarityMed')}</option>
            <option value={0.6}>{t('filters.similarityHigh')}</option>
            <option value={1.0}>{t('filters.similarityOff')}</option>
          </select>
        </div>
        <div className="flex gap-1.5 sm:gap-2">
          <button onClick={onExpandAll} className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95">
            <span className="hidden xs:inline">{t('filters.expandAll')}</span>
            <span className="xs:hidden">{t('filters.expand')}</span>
          </button>
          <button onClick={onCollapseAll} className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95">
            <span className="hidden xs:inline">{t('filters.collapseAll')}</span>
            <span className="xs:hidden">{t('filters.collapse')}</span>
          </button>
          {hasData ? <button
            onClick={onExportPDF}
            className="btn btn-secondary text-xs px-2 py-1 sm:px-3 sm:py-1.5 active:scale-95 flex items-center gap-1"
            title="Export as PDF"
          >
            <FileDown size={14} />
            <span className="hidden xs:inline">{t('filters.pdf')}</span>
          </button> : null}
        </div>
      </div>
    </div>
  )
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
  const { t } = useTranslation('problemAnalysis')
  const hasActiveFilters = Boolean(selectedSource ?? selectedCategory ?? selectedSubcategory ?? showUrgentOnly)

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
            value={selectedSource ?? ''}
            onChange={(e) => onSourceChange(e.target.value === '' ? null : e.target.value)}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
          >
            <option value="">{t('filters.allSources')}</option>
            {allSources.map((source) => (
              <option key={source} value={source}>{source}</option>
            ))}
          </select>
          <select
            value={selectedCategory ?? ''}
            onChange={(e) => {
              onCategoryChange(e.target.value === '' ? null : e.target.value); onSubcategoryChange(null)
            }}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
          >
            <option value="">{t('filters.allCategories')}</option>
            {allCategories.map((cat) => (
              <option key={cat} value={cat}>{cat.replace('_', ' ')}</option>
            ))}
          </select>
          <select
            value={selectedSubcategory ?? ''}
            onChange={(e) => onSubcategoryChange(e.target.value === '' ? null : e.target.value)}
            className="flex-1 sm:flex-none px-2.5 sm:px-3 py-1.5 border border-gray-300 rounded-lg text-xs sm:text-sm min-w-0 sm:min-w-[140px]"
          >
            <option value="">{t('filters.allSubcategories')}</option>
            {allSubcategories.map((sub) => (
              <option key={sub} value={sub}>{sub.replace('_', ' ')}</option>
            ))}
          </select>
        </div>

        <ControlsRow
          showUrgentOnly={showUrgentOnly}
          showResolved={showResolved}
          resolvedCount={resolvedCount}
          similarityThreshold={similarityThreshold}
          hasData={hasData}
          hasActiveFilters={hasActiveFilters}
          onUrgentOnlyChange={onUrgentOnlyChange}
          onShowResolvedChange={onShowResolvedChange}
          onSimilarityChange={onSimilarityChange}
          onExpandAll={onExpandAll}
          onCollapseAll={onCollapseAll}
          onExportPDF={onExportPDF}
          onClearFilters={clearFilters}
        />
      </div>
    </div>
  )
}
