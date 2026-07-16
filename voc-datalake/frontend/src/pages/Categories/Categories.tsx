/**
 * @fileoverview Categories analysis page with breakdown, filtering, and the
 * consolidated feedback list (search, urgent-only, All view) that replaced
 * the standalone Feedback page (issue #198).
 * @module pages/Categories
 */

import { useState } from 'react'
import { FileDown } from 'lucide-react'
import { getDateRangeParams } from '../../api/client'
import type { FeedbackItem } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import type { ViewMode } from './types'
import { SourceFilter } from './SourceFilter'
import { InsightsRow } from './InsightsRow'
import { SentimentGauge } from './SentimentGaugeCard'
import { WordCloudCard } from './WordCloudCard'
import { CategorySelector } from './CategorySelector'
import { CategoryDistribution } from './CategoryDistribution'
import { FeedbackResults } from './FeedbackResults'
import { FeedbackSearchBar } from './FeedbackSearchBar'
import { generateCategoriesPDF } from './categoriesPdfGenerator'
import { generateFeedbackPDF } from './feedbackPdfGenerator'
import { useCategoryFilters } from './useCategoryFilters'
import { useFeedbackListData } from './useFeedbackListData'
import { useCategoryAnalytics } from './useCategoryAnalytics'
import { useTranslation } from 'react-i18next'

function exportFeedbackCsv(items: FeedbackItem[]): void {
  const csv = [
    ['ID', 'Source', 'Category', 'Sentiment', 'Rating', 'Text', 'Date'].join(','),
    ...items.map(item => [
      item.feedback_id,
      item.source_platform,
      item.category,
      item.sentiment_label,
      item.rating || '',
      `"${item.original_text.replace(/"/g, '""')}"`,
      item.source_created_at,
    ].join(',')),
  ].join('\n')
  const blob = new Blob([csv], { type: 'text/csv' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `feedback-export-${new Date().toISOString().split('T')[0]}.csv`
  a.click()
}

/** PDF generation is best-effort (e.g. popup blocked) — never crash the page. */
function safeGeneratePdf(generate: () => void): void {
  try {
    generate()
  } catch (err) {
    console.error('PDF export failed:', err)
  }
}

export default function Categories() {
  const { t } = useTranslation('common')
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)

  const filters = useCategoryFilters()
  const [viewMode, setViewMode] = useState<ViewMode>('grid')
  const [showFilters, setShowFilters] = useState(false)

  const analytics = useCategoryAnalytics(dateParams, filters.selectedSource, config.apiEndpoint)
  const feedback = useFeedbackListData(dateParams, filters, config.apiEndpoint)

  const exportCsv = () => exportFeedbackCsv(feedback.filteredFeedback)

  const exportAnalyticsPdf = () => safeGeneratePdf(() => generateCategoriesPDF({
    categoryData: analytics.categoryData,
    sentimentData: analytics.sentimentData,
    wordCloudData: analytics.wordCloudData,
    totalIssues: analytics.totalIssues,
    avgSentiment: analytics.avgSentiment,
    timeRange,
    selectedSource: filters.selectedSource,
  }))

  const exportFeedbackListPdf = () => safeGeneratePdf(() => generateFeedbackPDF({
    items: feedback.filteredFeedback,
    timeRange: getTimeRangeLabel(timeRange, customDays, dateBasis),
    filters: {
      source: filters.selectedSource ?? 'all',
      sentiment: filters.sentimentFilter,
      category: filters.selectedCategories.join(', ') || 'all',
      search: filters.searchText,
      urgentOnly: filters.showUrgentOnly,
    },
  }))

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Please configure your API endpoint in Settings</p>
      </div>
    )
  }

  if (analytics.isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex justify-end">
        <button
          onClick={exportAnalyticsPdf}
          className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-700"
          title={t('exportPdfTooltip')}
        >
          <FileDown size={14} />
          {t('exportPdf')}
        </button>
      </div>
      <SourceFilter
        selectedSource={filters.selectedSource}
        onSourceChange={filters.setSelectedSource}
        allSources={analytics.allSources}
      />
      <FeedbackSearchBar
        searchText={filters.searchText}
        onSearchChange={filters.setSearchText}
        showUrgentOnly={filters.showUrgentOnly}
        onUrgentChange={filters.setShowUrgentOnly}
      />
      <InsightsRow categoryData={analytics.categoryData} totalIssues={analytics.totalIssues} />

      <CategoryDistribution
        categoryData={analytics.categoryData}
        totalIssues={analytics.totalIssues}
        periodDays={analytics.periodDays}
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <SentimentGauge
          sentimentData={analytics.sentimentData}
          avgSentiment={analytics.avgSentiment}
          sentimentFilter={filters.sentimentFilter}
          onSentimentFilterChange={filters.setSentimentFilter}
          percentages={analytics.sentimentPercentages}
        />
        <WordCloudCard
          wordCloudData={analytics.wordCloudData}
          selectedKeywords={filters.selectedKeywords}
          onToggleKeyword={filters.toggleKeyword}
          onClearKeywords={filters.clearKeywords}
        />
      </div>

      <CategorySelector
        categoryData={analytics.categoryData}
        totalIssues={analytics.totalIssues}
        selectedCategories={filters.selectedCategories}
        onToggleCategory={filters.toggleCategory}
        showAll={filters.showAll}
        onToggleShowAll={filters.toggleShowAll}
        hasActiveFilters={filters.hasActiveFilters}
        onClearFilters={filters.clearFilters}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(!showFilters)}
        minRating={filters.minRating}
        onMinRatingChange={filters.setMinRating}
        sentimentFilter={filters.sentimentFilter}
        onSentimentFilterChange={filters.setSentimentFilter}
      />

      {feedback.shouldFetchFeedback && (
        <FeedbackResults
          filteredFeedback={feedback.filteredFeedback}
          feedbackLoading={feedback.isLoading}
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          selectedSource={filters.selectedSource}
          selectedCategories={filters.selectedCategories}
          selectedKeywords={filters.selectedKeywords}
          sentimentFilter={filters.sentimentFilter}
          minRating={filters.minRating}
          onExport={exportCsv}
          onExportPdf={exportFeedbackListPdf}
          totalCount={feedback.totalCount}
          isPartialWindow={feedback.isPartialWindow}
        />
      )}
    </div>
  )
}
