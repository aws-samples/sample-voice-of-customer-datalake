/**
 * @fileoverview Feedback list page with filtering and search.
 *
 * Features:
 * - Full-text search across feedback items
 * - Filter by source, sentiment, category, urgency
 * - URL-synced filter state for shareable links
 * - Dynamic filter options from entities API
 * - Server-side pagination with "Load more"
 *
 * @module pages/Feedback
 */

import { useQuery } from '@tanstack/react-query'
import {
  Search, Filter, SortDesc, X, FileDown,
} from 'lucide-react'
import {
  useState, useEffect, useMemo,
} from 'react'
import { useTranslation } from 'react-i18next'
import { useSearchParams } from 'react-router-dom'
import { getDaysFromRange } from '../../api/baseUrl'
import { api } from '../../api/client'
import FeedbackCard from '../../components/FeedbackCard'
import PageLoader from '../../components/PageLoader'
import { useConfigStore } from '../../store/configStore'
import { generateFeedbackPDF } from './feedbackPdfGenerator'
import { useFeedbackData } from './useFeedbackData'
import type { FeedbackItem } from '../../api/types'

const sentiments = ['all', 'positive', 'neutral', 'negative', 'mixed']
const defaultCategories = ['all', 'delivery', 'customer_support', 'product_quality', 'pricing', 'website', 'app', 'billing', 'returns', 'communication', 'other']

function EmptyState() {
  const { t } = useTranslation('feedback')
  return (
    <div className="text-center py-12">
      <p className="text-gray-500">{t('noFeedbackFound')}</p>
    </div>
  )
}

function FeedbackGrid({ items }: Readonly<{ items: readonly FeedbackItem[] }>) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 sm:gap-4">
      {items.map((item) => (
        <FeedbackCard key={item.feedback_id} feedback={item} />
      ))}
    </div>
  )
}

function FeedbackListContent({
  isLoading, items, hasMore, isFetchingMore, onLoadMore,
}: Readonly<{
  isLoading: boolean
  items: readonly FeedbackItem[]
  hasMore: boolean
  isFetchingMore: boolean
  onLoadMore: () => void
}>) {
  if (isLoading) return <PageLoader />
  if (items.length === 0) return <EmptyState />
  return (
    <>
      <FeedbackGrid items={items} />
      {hasMore ? (
        <div className="flex justify-center pt-2 pb-4">
          <button
            onClick={onLoadMore}
            disabled={isFetchingMore}
            className="btn btn-secondary text-sm px-6 py-2 disabled:opacity-50"
          >
            {isFetchingMore ? 'Loading...' : 'Load more'}
          </button>
        </div>
      ) : null}
    </>
  )
}

function buildSourcesList(entitiesData: { entities?: { sources?: Record<string, number> } } | undefined): string[] {
  if (entitiesData?.entities?.sources == null) return ['all']
  const sourceNames = Object.keys(entitiesData.entities.sources)
    .sort((a, b) => (entitiesData.entities?.sources?.[b] ?? 0) - (entitiesData.entities?.sources?.[a] ?? 0))
  return ['all', ...sourceNames]
}

function buildCategoriesList(entitiesData: { entities?: { categories?: Record<string, number> } } | undefined): string[] {
  if (entitiesData?.entities?.categories == null) return defaultCategories
  const categoryNames = Object.keys(entitiesData.entities.categories)
    .sort((a, b) => (entitiesData.entities?.categories?.[b] ?? 0) - (entitiesData.entities?.categories?.[a] ?? 0))
  return ['all', ...categoryNames]
}

function checkHasActiveFilters(filters: FilterState): boolean {
  return Boolean(filters.search) || filters.sourceFilter !== 'all' || filters.sentimentFilter !== 'all' || filters.categoryFilter !== 'all' || filters.showUrgentOnly
}

interface FilterState {
  search: string
  sourceFilter: string
  sentimentFilter: string
  categoryFilter: string
  showUrgentOnly: boolean
}

function FiltersCard({
  filters,
  sources,
  categories,
  onSearchChange,
  onSourceChange,
  onSentimentChange,
  onCategoryChange,
  onUrgentChange,
}: Readonly<{
  filters: FilterState
  sources: string[]
  categories: string[]
  onSearchChange: (value: string) => void
  onSourceChange: (value: string) => void
  onSentimentChange: (value: string) => void
  onCategoryChange: (value: string) => void
  onUrgentChange: (value: boolean) => void
}>) {
  const { t } = useTranslation()
  return (
    <div className="card !p-4 sm:!p-6">
      <div className="flex flex-col gap-3 sm:gap-4">
        <div className="relative w-full">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" size={18} />
          <input
            type="text"
            placeholder={t('filters.searchFeedback')}
            value={filters.search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="input !pl-11"
          />
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-4">
          <div className="flex items-center gap-2 min-w-0">
            <Filter size={16} className="text-gray-400 flex-shrink-0 hidden sm:block" />
            <select value={filters.sourceFilter} onChange={(e) => onSourceChange(e.target.value)} className="input w-full sm:w-auto text-sm">
              {sources.map((s) => <option key={s} value={s}>{s === 'all' ? t('filters.allSources') : s}</option>)}
            </select>
          </div>
          <select value={filters.sentimentFilter} onChange={(e) => onSentimentChange(e.target.value)} className="input w-full sm:w-auto text-sm flex-1 sm:flex-none">
            {sentiments.map((s) => <option key={s} value={s}>{s === 'all' ? t('filters.allSentiments') : t(`sentiment.${s}`)}</option>)}
          </select>
          <select value={filters.categoryFilter} onChange={(e) => onCategoryChange(e.target.value)} className="input w-full sm:w-auto text-sm flex-1 sm:flex-none">
            {categories.map((c) => <option key={c} value={c}>{c === 'all' ? t('filters.allCategories') : c.replace('_', ' ')}</option>)}
          </select>
          <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
            <input type="checkbox" checked={filters.showUrgentOnly} onChange={(e) => onUrgentChange(e.target.checked)} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500" />
            <span className="text-sm text-gray-700">{t('filters.urgentOnly')}</span>
          </label>
        </div>
      </div>
    </div>
  )
}

function ResultsHeader({
  itemCount,
  totalCount,
  search,
  hasActiveFilters,
  onClearFilters,
}: Readonly<{
  itemCount: number
  totalCount: number
  search: string
  hasActiveFilters: boolean
  onClearFilters: () => void
}>) {
  const { t } = useTranslation()
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
      <p className="text-sm text-gray-500">
        {t('showingOf', {
          count: itemCount,
          total: totalCount,
        })}
        {search === '' ? null : <span className="ml-1">{t('forQuery', { query: search })}</span>}
      </p>
      <div className="flex items-center gap-3">
        {hasActiveFilters ? <button onClick={onClearFilters} className="flex items-center gap-1 text-sm text-red-600 hover:text-red-700">
          <X size={14} />
          {t('filters.clearFilters')}
        </button> : null}
        <button className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700">
          <SortDesc size={14} />
          {t('filters.mostRecent')}
        </button>
      </div>
    </div>
  )
}

function buildUrlParams(search: string, sourceFilter: string, sentimentFilter: string, categoryFilter: string): URLSearchParams {
  const params = new URLSearchParams()
  if (search !== '') params.set('q', search)
  if (sourceFilter !== 'all') params.set('source', sourceFilter)
  if (sentimentFilter !== 'all') params.set('sentiment', sentimentFilter)
  if (categoryFilter !== 'all') params.set('category', categoryFilter)
  return params
}

function buildPDFFilters(filterState: FilterState) {
  return {
    source: filterState.sourceFilter === 'all' ? undefined : filterState.sourceFilter,
    sentiment: filterState.sentimentFilter === 'all' ? undefined : filterState.sentimentFilter,
    category: filterState.categoryFilter === 'all' ? undefined : filterState.categoryFilter,
    search: filterState.search === '' ? undefined : filterState.search,
    urgentOnly: filterState.showUrgentOnly,
  }
}

function PDFExportButton({
  items, timeRange, filterState,
}: Readonly<{
  items: FeedbackItem[]
  timeRange: string
  filterState: FilterState
}>) {
  if (items.length === 0) return null
  const exportPDF = () => {
    try {
      generateFeedbackPDF({
        items,
        timeRange,
        filters: buildPDFFilters(filterState),
      })
    } catch {
      // PDF generation is best-effort
    }
  }
  return (
    <div className="flex justify-end">
      <button onClick={exportPDF} className="btn btn-secondary text-xs sm:text-sm px-3 py-1.5 active:scale-95 flex items-center gap-1.5" title="Export as PDF">
        <FileDown size={14} />
        PDF
      </button>
    </div>
  )
}

export default function Feedback() {
  const { t } = useTranslation('feedback')
  const {
    timeRange, config,
  } = useConfigStore()
  const days = getDaysFromRange(timeRange)
  const [searchParams, setSearchParams] = useSearchParams()
  const hasApiEndpoint = config.apiEndpoint !== ''

  const [search, setSearch] = useState(searchParams.get('q') ?? '')
  const [sourceFilter, setSourceFilter] = useState(searchParams.get('source') ?? 'all')
  const [sentimentFilter, setSentimentFilter] = useState(searchParams.get('sentiment') ?? 'all')
  const [categoryFilter, setCategoryFilter] = useState(searchParams.get('category') ?? 'all')
  const [showUrgentOnly, setShowUrgentOnly] = useState(false)

  const { data: entitiesData } = useQuery({
    queryKey: ['entities', days],
    queryFn: () => api.getEntities({
      days,
      limit: 100,
    }),
    enabled: hasApiEndpoint,
  })

  const sources = useMemo(() => buildSourcesList(entitiesData), [entitiesData])
  const categories = useMemo(() => buildCategoriesList(entitiesData), [entitiesData])

  useEffect(() => {
    const params = buildUrlParams(search, sourceFilter, sentimentFilter, categoryFilter)
    setSearchParams(params, { replace: true })
  }, [search, sourceFilter, sentimentFilter, categoryFilter, setSearchParams])

  const {
    data: activeData, isLoading, isFetchingMore, hasMore, loadMore,
  } = useFeedbackData({
    hasApiEndpoint,
    days,
    search,
    sourceFilter,
    sentimentFilter,
    categoryFilter,
    showUrgentOnly,
  })

  const items = activeData?.items ?? []
  const filterState: FilterState = {
    search,
    sourceFilter,
    sentimentFilter,
    categoryFilter,
    showUrgentOnly,
  }
  const hasActiveFilters = checkHasActiveFilters(filterState)

  const clearFilters = () => {
    setSearch('')
    setSourceFilter('all')
    setSentimentFilter('all')
    setCategoryFilter('all')
    setShowUrgentOnly(false)
  }

  if (config.apiEndpoint === '') {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">{t('configureEndpoint')}</p>
      </div>
    )
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <FiltersCard
        filters={filterState}
        sources={sources}
        categories={categories}
        onSearchChange={setSearch}
        onSourceChange={setSourceFilter}
        onSentimentChange={setSentimentFilter}
        onCategoryChange={setCategoryFilter}
        onUrgentChange={setShowUrgentOnly}
      />
      <ResultsHeader
        itemCount={items.length}
        totalCount={activeData?.total ?? 0}
        search={search}
        hasActiveFilters={hasActiveFilters}
        onClearFilters={clearFilters}
      />
      <PDFExportButton items={items} timeRange={timeRange} filterState={filterState} />
      <FeedbackListContent
        isLoading={isLoading}
        items={items}
        hasMore={hasMore}
        isFetchingMore={isFetchingMore}
        onLoadMore={loadMore}
      />
    </div>
  )
}
