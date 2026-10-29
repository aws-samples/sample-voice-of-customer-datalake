/**
 * @fileoverview The Problem Analysis filter card: the review-type chips, source, category
 * and subcategory selects (the subcategory list narrows to the chosen category), the
 * urgent-only and show-resolved toggles, Clear, Similarity and Expand / Collapse all.
 * The period is the header's. State lives in the URL (`useProblemFilters`).
 * @module pages/ProblemAnalysis/ProblemFiltersBar
 */
import { Filter, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useDisplayLabels } from '../../hooks/useDisplayLabels'
import OptionSelect from '../../components/OptionSelect/OptionSelect'
import { SimilaritySelect } from './SimilaritySelect'
import type { ProblemFiltersApi } from './useProblemFilters'
import { ProblemTypeChips } from './ProblemTypeChips'

interface ProblemFiltersBarProps {
  readonly filters: ProblemFiltersApi
  readonly sources: readonly string[]
  readonly categories: readonly string[]
  /** Subcategories of the chosen category (every one when none is chosen). */
  readonly subcategories: readonly string[]
  readonly resolvedCount: number
  /** Reviews per type in the window (`type_counts`). */
  readonly typeCounts: Readonly<Record<string, number>>
  readonly onExpandAll: () => void
  readonly onCollapseAll: () => void
}

const SELECT = 'select w-full sm:w-auto sm:min-w-[160px]'

function Toggle({ checked, onChange, children }: Readonly<{ checked: boolean; onChange: (next: boolean) => void; children: string }>) {
  return (
    <label className="flex items-center gap-2 min-h-9 text-sm cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="rounded-sm accent-accent focus-ring w-4 h-4" />
      <span>{children}</span>
    </label>
  )
}

export function ProblemFiltersBar({ filters, sources, categories, subcategories, resolvedCount, typeCounts, onExpandAll, onCollapseAll }: ProblemFiltersBarProps) {
  const { t } = useTranslation(['problemAnalysis', 'common'])
  const labels = useDisplayLabels()
  return (
    <div className="card">
      <div className="flex flex-col gap-3 sm:gap-4">
        <ProblemTypeChips value={filters.types} onChange={(types) => filters.update({ types })} counts={typeCounts} />
        <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-2 sm:gap-3">
          <Filter size={16} className="hidden sm:block text-muted flex-shrink-0" aria-hidden="true" />
          <OptionSelect className={SELECT} label={t('filters.source')} allLabel={t('filters.allSources')} value={filters.source}
            options={sources} display={labels.source} onChange={(source) => filters.update({ source })} />
          <OptionSelect className={SELECT} label={t('filters.category')} allLabel={t('filters.allCategories')} value={filters.category}
            options={categories} display={labels.category} onChange={(category) => filters.update({ category })} />
          <OptionSelect className={SELECT} label={t('filters.subcategory')} allLabel={t('filters.allSubcategories')} value={filters.subcategory}
            options={subcategories} display={(sub) => labels.subcategory(sub, filters.category ?? undefined)}
            onChange={(subcategory) => filters.update({ subcategory })} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 sm:gap-4">
          <div className="flex flex-wrap items-center gap-2 sm:gap-3">
            <Toggle checked={filters.urgentOnly} onChange={(urgentOnly) => filters.update({ urgentOnly })}>{t('filters.urgentOnly')}</Toggle>
            {/* Counts resolved problems within the CURRENT filters (what the toggle would reveal). */}
            <Toggle checked={filters.showResolved} onChange={(showResolved) => filters.update({ showResolved })}>
              {t('common:problemResolution.showResolved', { total: resolvedCount })}
            </Toggle>
            {filters.anyActive && (
              <button type="button" onClick={filters.clear} className="btn btn-ghost btn-sm">
                <X size={14} aria-hidden="true" />
                {t('filters.clear')}
              </button>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 sm:gap-4">
            <SimilaritySelect value={filters.similarity} onChange={(similarity) => filters.update({ similarity })} />
            <div className="flex gap-2">
              <button type="button" onClick={onExpandAll} className="btn btn-secondary btn-sm">{t('filters.expandAll')}</button>
              <button type="button" onClick={onCollapseAll} className="btn btn-secondary btn-sm">{t('filters.collapseAll')}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
