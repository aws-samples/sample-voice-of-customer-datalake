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
import { getDateRangeParams } from '../../api/client'
import type { FeedbackItem } from '../../api/types'
import { useConfigStore } from '../../store/configStore'
import { getTimeRangeLabel } from '../../utils/dateUtils'
import type { ViewMode } from './types'
import { FilterBar } from './FilterBar'
import { SentimentGauge } from './SentimentGaugeCard'
import { WordCloudCard } from './WordCloudCard'
import { CategoryDistribution } from './CategoryDistribution'
import { FeedbackResults } from './FeedbackResults'
import { generateCategoriesPDF } from './categoriesPdfGenerator'
import { attributeFiltersOf, useCategoryFilters } from './useCategoryFilters'
import { AttributeFilterControls } from './AttributeFilterControls'
import { useDimensionsConfig } from '../../hooks/useDimensions'
import type { CategoryFiltersApi } from './useCategoryFilters'
import { useFeedbackListData } from './useFeedbackListData'
import { useCategoryAnalytics } from './useCategoryAnalytics'
import type { CategoryAnalytics } from './useCategoryAnalytics'
import { csvField } from '../../utils/csv'
import { useTranslation } from 'react-i18next'
import { CenteredSpinner, ExportPageHeader } from './ExportPageHeader'
import LoadFailed from '../../components/LoadFailed/LoadFailed'

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

/** The three analytics cards — or, when their reads failed, a LoadFailed (not "no categories" and 0 %). */
function AnalyticsCards({ analytics, filters }: Readonly<{ analytics: CategoryAnalytics; filters: CategoryFiltersApi }>) {
  if (analytics.loadFailed) {
    return (
      <div className="lg:col-span-3">
        <LoadFailed onRetry={analytics.retry} retrying={analytics.retrying} />
      </div>
    )
  }
  return (
    <>
      <CategoryDistribution
        categoryData={analytics.categoryData}
        totalIssues={analytics.totalIssues}
        periodDays={analytics.periodDays}
        selectedCategories={filters.selectedCategories}
        onToggleCategory={filters.toggleCategory}
      />
      <SentimentGauge
        sentimentData={analytics.sentimentData}
        avgSentiment={analytics.avgSentiment}
        sentimentFilter={filters.sentimentFilter}
        onSentimentFilterChange={filters.setSentimentFilter}
        percentages={analytics.sentimentPercentages}
      />
      <WordCloudCard
        wordCloudData={analytics.wordCloudData}
        searchText={filters.searchText}
        onSearchChange={filters.setSearchText}
      />
    </>
  )
}

export default function Categories() {
  const { t } = useTranslation(['common', 'categories'])
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)

  const filters = useCategoryFilters()
  const [viewMode, setViewMode] = useState<ViewMode>('grid')

  const { data: dimensionsConfig } = useDimensionsConfig()
  const analytics = useCategoryAnalytics(dateParams, filters.selectedSource, config.apiEndpoint, attributeFiltersOf(filters))
  const feedback = useFeedbackListData(dateParams, filters, config.apiEndpoint)

  const exportCsv = () => exportFeedbackCsv(feedback.filteredFeedback)

  // One report: analytics sections plus the currently filtered feedback items.
  const exportPdf = () => safeGeneratePdf(() => generateCategoriesPDF({
    categoryData: analytics.categoryData,
    sentimentData: analytics.sentimentData,
    wordCloudData: analytics.wordCloudData,
    totalIssues: analytics.totalIssues,
    avgSentiment: analytics.avgSentiment,
    timeRange: getTimeRangeLabel(timeRange, customDays, dateBasis),
    selectedSource: filters.selectedSource,
    items: feedback.filteredFeedback,
  }))

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-muted">{t('categories:configureApiEndpoint')}</p>
      </div>
    )
  }

  if (analytics.isLoading) {
    return <CenteredSpinner />
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <ExportPageHeader
        title={t('categories:title')}
        subtitle={t('categories:subtitle')}
        onExport={exportPdf}
      />

      <FilterBar
        searchText={filters.searchText}
        onSearchChange={filters.setSearchText}
        selectedSource={filters.selectedSource}
        onSourceChange={filters.setSelectedSource}
        allSources={analytics.allSources}
        showUrgentOnly={filters.showUrgentOnly}
        onUrgentChange={filters.setShowUrgentOnly}
        ratingFilter={filters.ratingFilter}
        onRatingFilterChange={filters.setRatingFilter}
        hasActiveFilters={filters.hasActiveFilters}
        onClearFilters={filters.clearFilters}
      >
        <AttributeFilterControls
          channels={analytics.allChannels}
          channel={filters.channel}
          onChannelChange={filters.setChannel}
          tags={analytics.allTags}
          tag={filters.tag}
          onTagChange={filters.setTag}
          dimensions={dimensionsConfig?.dimensions ?? []}
          dimensionFilter={filters.dimensionFilter}
          onDimensionFilterChange={filters.setDimensionFilter}
        />
      </FilterBar>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-6">
        <AnalyticsCards analytics={analytics} filters={filters} />
      </div>

      <FeedbackResults
        filteredFeedback={feedback.filteredFeedback}
        feedbackLoading={feedback.isLoading}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        selectedSource={filters.selectedSource}
        selectedCategories={filters.selectedCategories}
        sentimentFilter={filters.sentimentFilter}
        ratingFilter={filters.ratingFilter}
        onExport={exportCsv}
        totalCount={feedback.totalCount}
        isPartialWindow={feedback.isPartialWindow}
        hasMore={feedback.hasMore}
        onLoadMore={feedback.loadMore}
        isLoadingMore={feedback.isLoadingMore}
        failure={feedback.failure}
      />
    </div>
  )
}
