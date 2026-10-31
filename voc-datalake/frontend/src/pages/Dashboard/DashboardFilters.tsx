/**
 * @fileoverview The Dashboard's filter bar (source, category, sentiment, usefulness; URL
 * state through `useFacetParams`) and what the page shows when the filters match nothing.
 *
 * A filtered window with no reviews is the honest answer to the question asked, not an empty
 * workspace: the page keeps its filter bar and says so, with "Clear filters", instead of the
 * welcome or "show all time" state (PR #429's empty-window rule, @aws-bryan: never widen or
 * replace a filtered answer with unrelated data).
 *
 * @module pages/Dashboard/DashboardFilters
 */
import { FilterX, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { hasActiveFacets } from '../../api/feedbackFacets'
import {
  CategoryFacetSelect, SentimentFacetSelect, SourceFacetSelect, UsefulnessFacetSelect,
} from '../../components/FacetMultiSelect/FacetSelects'
import type { FacetParamsApi } from '../../hooks/useFacetParams'

interface DashboardFiltersProps {
  readonly params: FacetParamsApi
  readonly sourceOptions: readonly string[]
  readonly categoryOptions: readonly string[]
}

export function DashboardFilters({ params, sourceOptions, categoryOptions }: DashboardFiltersProps) {
  const { t } = useTranslation('components')
  const { facets, toggle, clearFacet, clearAll } = params
  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-3" role="group" aria-label={t('facetFilters.groupLabel')}>
      <SourceFacetSelect options={sourceOptions} selected={facets.sources}
        onToggle={(value) => toggle('sources', value)} onClear={() => clearFacet('sources')} />
      <CategoryFacetSelect options={categoryOptions} selected={facets.categories}
        onToggle={(value) => toggle('categories', value)} onClear={() => clearFacet('categories')} />
      <SentimentFacetSelect selected={facets.sentiments}
        onToggle={(value) => toggle('sentiments', value)}
        onClear={() => clearFacet('sentiments')} />
      <UsefulnessFacetSelect selected={facets.usefulness}
        onToggle={(value) => toggle('usefulness', value)}
        onClear={() => clearFacet('usefulness')} />
      {hasActiveFacets(facets) && (
        <button type="button" className="btn btn-ghost btn-sm whitespace-nowrap" onClick={clearAll}>
          <X size={14} aria-hidden="true" />
          {t('facetFilters.clearAll')}
        </button>
      )}
    </div>
  )
}

/** "No feedback matches these filters", in place of the cards. */
export function FilteredEmpty({ onClear }: Readonly<{ onClear: () => void }>) {
  const { t } = useTranslation('components')
  return (
    <div className="card flex flex-col items-center gap-3 py-10 text-center" role="status">
      <FilterX size={28} className="text-muted" aria-hidden="true" />
      <p className="font-medium text-text-strong">{t('facetFilters.noMatchTitle')}</p>
      <p className="text-sm text-muted">{t('facetFilters.noMatchHint')}</p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={onClear}>{t('facetFilters.clearAll')}</button>
    </div>
  )
}
