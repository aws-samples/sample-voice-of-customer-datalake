/**
 * @fileoverview Categories analysis page: one unified filter bar, three
 * interactive analytics cards (category distribution doubles as the category
 * selector, sentiment gauge legend is the sentiment control, keyword clicks
 * populate search), and the consolidated feedback list that replaced the
 * standalone Feedback page (issue #198). The default view (nothing selected)
 * browses all feedback.
 * @module pages/Categories
 */

import { useState } from 'react'
import clsx from 'clsx'
import { FileDown } from 'lucide-react'
import { getDateRangeParams } from '../../api/client'
import type { FeedbackItem } from '../../api/client'
import { filtersKey } from '../../api/feedbackFilters'
import { useConfigStore } from '../../store/configStore'
import { FILTER_QUERY_DEBOUNCE_MS, useDebouncedValue } from '../../hooks/useDebouncedValue'
import { useSettledOnce } from '../../hooks/useSettledOnce'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import type { ViewMode } from './types'
import { RatingPicker, SearchBox } from './FilterBar'
import { SentimentGauge } from './SentimentGaugeCard'
import { WordCloudCard } from './WordCloudCard'
import { CategoryDistribution } from './CategoryDistribution'
import { FeedbackResults } from './FeedbackResults'
import { generateCategoriesPDF } from './categoriesPdfGenerator'
import { useCategoryFilters } from './useCategoryFilters'
import type { CategoryFiltersApi, CategoryFiltersState } from './useCategoryFilters'
import { useFeedbackListData } from './useFeedbackListData'
import { analyticsFacetFilters, useCategoryAnalytics } from './useCategoryAnalytics'
import type { CategoryAnalytics } from './useCategoryAnalytics'
import { useCustomFilterControls } from './useCustomFilterControls'
import { useEmptyWindowFallback } from '../../hooks/useEmptyWindowFallback'
import EmptyWindowBanner from '../../components/EmptyWindowBanner'
import FeedbackFilterPanel from '../../components/FeedbackFilterPanel'
import FeedbackDetailOverlay from '../../components/FeedbackDetailOverlay'
import type { CustomFilterControl } from '../../components/FeedbackFilterPanel'
import { csvField } from '../../utils/csv'
import { useTranslation } from 'react-i18next'

function exportFeedbackCsv(items: FeedbackItem[]): void {
  const csv = [
    ['ID', 'Source', 'Category', 'Sentiment', 'Rating', 'Text', 'Date'].map(csvField).join(','),
    ...items.map(item => [
      csvField(item.feedback_id),
      csvField(item.source_platform),
      csvField(item.category),
      csvField(item.sentiment_label),
      csvField(item.rating ?? ''),
      csvField(item.original_text),
      csvField(item.source_created_at),
    ].join(',')),
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = `feedback-export-${new Date().toISOString().split('T')[0]}.csv`
    a.click()
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * PDF generation is best-effort (e.g. popup blocked) — never crash the page.
 * Only the error message is logged: the full error object could carry
 * feedback content from the report payload.
 */
function safeGeneratePdf(generate: () => void): void {
  try {
    generate()
  } catch (err) {
    console.error('PDF export failed:', err instanceof Error ? err.message : String(err))
  }
}

/**
 * What the queries read: the panel's live selection and search text, once the
 * user has paused, so several quick changes (or a typed word) cost one request.
 * The star rating stays live — it is refined client-side, no request involved.
 */
function useQueryState(state: CategoryFiltersApi): CategoryFiltersState & { readonly isPending: boolean } {
  const filters = useDebouncedValue(state.filters, FILTER_QUERY_DEBOUNCE_MS)
  const searchText = useDebouncedValue(state.searchText, FILTER_QUERY_DEBOUNCE_MS)
  return {
    filters,
    searchText,
    ratingFilter: state.ratingFilter,
    isPending: searchText !== state.searchText || filtersKey(filters) !== filtersKey(state.filters),
  }
}

function PageSpinner() {
  return (
    <div className="flex items-center justify-center h-full py-12">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
    </div>
  )
}

interface AnalyticsCardsProps {
  readonly analytics: CategoryAnalytics
  readonly state: CategoryFiltersApi
}

/** The three interactive cards; a reload renders here, never by replacing the page. */
function AnalyticsCards({ analytics, state }: AnalyticsCardsProps) {
  if (analytics.isLoading) return <PageSpinner />
  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
      <CategoryDistribution
        categoryData={analytics.categoryData}
        totalIssues={analytics.totalIssues}
        periodDays={analytics.periodDays}
        selectedCategories={[...state.filters.categories]}
        onToggleCategory={state.toggleCategory}
      />
      <SentimentGauge
        sentimentData={analytics.sentimentData}
        avgSentiment={analytics.avgSentiment}
        selectedSentiments={state.filters.sentiments}
        onToggleSentiment={state.toggleSentiment}
        percentages={analytics.sentimentPercentages}
      />
      <WordCloudCard
        wordCloudData={analytics.wordCloudData}
        searchText={state.searchText}
        onSearchChange={state.setSearchText}
      />
    </div>
  )
}

interface CategoriesFilterPanelProps {
  readonly state: CategoryFiltersApi
  readonly sources: Readonly<Record<string, number>>
  readonly categories: readonly string[]
  readonly customFilterControls: readonly CustomFilterControl[]
  readonly onExportPdf: () => void
  readonly isUpdating: boolean
}

function CategoriesFilterPanel({ state, sources, categories, customFilterControls, onExportPdf, isUpdating }: CategoriesFilterPanelProps) {
  const { t } = useTranslation('common')
  return (
    <FeedbackFilterPanel
      filters={state.filters}
      onChange={state.setFilters}
      options={{ sources: Object.keys(sources), categories }}
      counts={{ sources }}
      customFilterControls={customFilterControls}
      headerExtra={<SearchBox searchText={state.searchText} onSearchChange={state.setSearchText} />}
      extra={<RatingPicker ratingFilter={state.ratingFilter} onRatingFilterChange={state.setRatingFilter} />}
      extraActive={state.searchText !== '' || state.ratingFilter.value > 0}
      onClearExtra={state.clearFilters}
      isUpdating={isUpdating}
      trailing={
        <button
          onClick={onExportPdf}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700 whitespace-nowrap"
          title={t('exportPdfTooltip')}
        >
          <FileDown size={14} />
          {t('exportPdf')}
        </button>
      }
    />
  )
}

export default function Categories() {
  const { t } = useTranslation(['common', 'categories'])
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)

  const filters = useCategoryFilters()
  const query = useQueryState(filters)
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [openFeedback, setOpenFeedback] = useState<FeedbackItem | null>(null)
  const facetFilters = analyticsFacetFilters(query.filters)

  // Analytics on the user's selected window first — its emptiness decides whether
  // to fall back. Only fall back when NO filters are active: a filtered window
  // that matches nothing is an honest empty result (the user asked a specific
  // question), not stale-data-out-of-range, so widening it would surface
  // unrelated feedback and misrepresent the filter.
  const selectedAnalytics = useCategoryAnalytics(dateParams, facetFilters, config.apiEndpoint)
  const selectedEmpty = !filters.hasActiveFilters && !selectedAnalytics.isLoading && selectedAnalytics.totalIssues === 0
  const { effectiveDateParams, fallback, isResolving } = useEmptyWindowFallback(
    dateParams, selectedEmpty, selectedAnalytics.isLoading, config.apiEndpoint, dateBasis,
  )

  // Re-query at the effective window. When no fallback is active
  // effectiveDateParams === dateParams, so these resolve to the same cache
  // entries as the probe queries above (no extra fetch).
  const analytics = useCategoryAnalytics(effectiveDateParams, facetFilters, config.apiEndpoint)
  const feedback = useFeedbackListData(effectiveDateParams, query, config.apiEndpoint)
  const customFilterControls = useCustomFilterControls(config.apiEndpoint)
  // `isResolving` counts as loading so the page doesn't briefly render an empty
  // grid before the empty-window fallback widens.
  const settled = useSettledOnce(analytics.isLoading || isResolving)
  const isUpdating = query.isPending || analytics.isUpdating || feedback.isUpdating

  const exportCsv = () => exportFeedbackCsv(feedback.filteredFeedback)

  // One report: analytics sections plus the currently filtered feedback items.
  const exportPdf = () => safeGeneratePdf(() => generateCategoriesPDF({
    categoryData: analytics.categoryData,
    sentimentData: analytics.sentimentData,
    wordCloudData: analytics.wordCloudData,
    totalIssues: analytics.totalIssues,
    avgSentiment: analytics.avgSentiment,
    timeRange: getTimeRangeLabel(timeRange, customDays, dateBasis),
    // The sources the exported numbers were queried with.
    selectedSource: query.filters.sources.length > 0 ? query.filters.sources.join(', ') : null,
    items: feedback.filteredFeedback,
  }))

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">{t('categories:configureApiEndpoint')}</p>
      </div>
    )
  }

  // Full-page spinner for the FIRST load only; later reloads render inside
  // AnalyticsCards / FeedbackResults so the panel stays open between changes.
  if (!settled) return <PageSpinner />

  return (
    <div className="space-y-4 sm:space-y-6">
      {fallback ? <EmptyWindowBanner date={fallback.latestDate} /> : null}
      <CategoriesFilterPanel
        state={filters}
        sources={analytics.sourceCounts}
        categories={analytics.categoryData.map((c) => c.name)}
        customFilterControls={customFilterControls}
        onExportPdf={exportPdf}
        isUpdating={isUpdating}
      />

      {/* Earlier results stay visible (dimmed) while the current selection loads. */}
      <div aria-busy={isUpdating} className={clsx('space-y-4 sm:space-y-6 transition-opacity', isUpdating && 'opacity-60')}>
        <AnalyticsCards analytics={analytics} state={filters} />
        <FeedbackResults
          filteredFeedback={feedback.filteredFeedback}
          feedbackLoading={feedback.isLoading}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          selectedSources={filters.filters.sources}
          selectedCategories={filters.filters.categories}
          selectedSentiments={filters.filters.sentiments}
          ratingFilter={filters.ratingFilter}
          onOpenFeedback={setOpenFeedback}
          onExport={exportCsv}
          totalCount={feedback.totalCount}
          isPartialWindow={feedback.isPartialWindow}
          hasMore={feedback.hasMore}
          onLoadMore={feedback.loadMore}
          isLoadingMore={feedback.isLoadingMore}
        />
      </div>
      <FeedbackDetailOverlay feedback={openFeedback} onClose={() => setOpenFeedback(null)} />
    </div>
  )
}
