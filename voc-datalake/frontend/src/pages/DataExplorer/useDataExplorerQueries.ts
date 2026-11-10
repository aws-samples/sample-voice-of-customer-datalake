/**
 * @fileoverview Custom hooks for Data Explorer queries.
 * @module pages/DataExplorer/useDataExplorerQueries
 */

import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { normalizeBuckets, normalizeS3Listing } from './dataExplorerSchema'
import { failedReads } from '../../utils/failedReads'
import { useDebouncedValue } from '../../hooks/useDebouncedValue'
import type { DateRangeParams } from '../../api/client'
import type { FeedbackItem } from '../../api/types'
import { metricsKeys } from '../../api/queryKeys'
import { FEEDBACK_SEARCH_MIN_CHARS } from '../../api/feedbackSearch'

type ViewMode = 's3-raw' | 'dynamodb-processed'

const SEARCH_DEBOUNCE_MS = 300
const PROCESSED_PAGE_LIMIT = 100

/** The processed-feedback list as the view shows it: the rows, and the count they are part of. */
/** The page's own reads; the mutations invalidate them by root (no arguments). */
export const dataExplorerKeys = {
  s3: (...params: readonly unknown[]) => ['data-explorer-s3', ...params] as const,
  feedback: (...params: readonly unknown[]) => ['data-explorer-feedback', ...params] as const,
}

export interface ProcessedFeedbackData {
  items: FeedbackItem[]
  /** Matching items in the window (the list's candidate window, or every search match). */
  total: number
  /** True when `total` is a lower bound ("N or more"). */
  isLowerBound: boolean
}

/** Where the next page starts: an offset into `/feedback`, or a `/feedback/search` cursor. */
type PageCursor = { offset: number } | { token: string }

/** The first page has no cursor. */
const FIRST_PAGE: PageCursor | null = null

interface ProcessedPage extends ProcessedFeedbackData {
  next: PageCursor | null
}

/** `/feedback` has more when fewer rows than `total` are loaded, or its window was cut while this page was full. */
function listNext(offset: number, count: number, total: number, partial: boolean): PageCursor | null {
  const loaded = offset + count
  const more = loaded < total || (partial && count >= PROCESSED_PAGE_LIMIT)
  return more && count > 0 ? { offset: loaded } : null
}

/**
 * One page of the processed-feedback read: a SERVER search (`/feedback/search`,
 * cursor-paged) once the box holds 2+ characters, so the count covers every match
 * in the window; otherwise the plain list (offset-paged).
 */
async function readProcessedPage(
  dateParams: DateRangeParams, source: string | undefined, searchText: string, cursor: PageCursor | null,
): Promise<ProcessedPage> {
  const params = { ...dateParams, source, limit: PROCESSED_PAGE_LIMIT }
  if (searchText) {
    const nextToken = cursor !== null && 'token' in cursor ? cursor.token : undefined
    const res = await api.searchFeedback({ ...params, q: searchText, next_token: nextToken })
    return {
      items: res.items,
      total: res.total ?? res.items.length,
      isLowerBound: res.is_partial_window === true || (res.total == null && res.has_more),
      next: res.has_more && res.next_token ? { token: res.next_token } : null,
    }
  }
  const offset = cursor !== null && 'offset' in cursor ? cursor.offset : 0
  const res = await api.getFeedback({ ...params, offset })
  return {
    items: res.items, total: res.total, isLowerBound: res.is_partial_window,
    next: listNext(offset, res.items.length, res.total, res.is_partial_window),
  }
}

/** Every loaded page as one list; the count is the latest page's (it saw the widest window). */
function flattenPages(pages: readonly ProcessedPage[]): ProcessedFeedbackData | undefined {
  const last = pages.at(-1)
  if (last === undefined) return undefined
  const items = pages.flatMap((page) => page.items)
  return { items, total: Math.max(last.total, items.length), isLowerBound: last.isLowerBound }
}

// Wire-boundary normalization (dataExplorerSchema.ts): components never trust a
// response to match its declared type. Module-level so `select` keeps a stable
// identity — TanStack Query then runs it once per response, not once per render.
const selectBuckets = (raw: unknown) => ({ buckets: normalizeBuckets(raw) })

export function useDataExplorerQueries(
  viewMode: ViewMode,
  selectedBucket: string,
  s3Path: string[],
  sourceFilter: string,
  searchQuery: string
) {
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const debounced = useDebouncedValue(searchQuery.trim(), SEARCH_DEBOUNCE_MS)
  const searchText = debounced.length >= FEEDBACK_SEARCH_MIN_CHARS ? debounced : ''
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const isConfigured = !!config.apiEndpoint

  const bucketsQuery = useQuery({
    queryKey: ['data-explorer-buckets'],
    queryFn: () => api.getDataExplorerBuckets(),
    select: selectBuckets,
    enabled: isConfigured,
  })

  const s3Query = useQuery({
    queryKey: dataExplorerKeys.s3(selectedBucket, s3Path.join('/')),
    queryFn: () => api.getDataExplorerS3(s3Path.join('/'), selectedBucket),
    select: normalizeS3Listing,
    enabled: isConfigured && viewMode === 's3-raw',
  })

  const isProcessed = viewMode === 'dynamodb-processed'
  const feedbackQuery = useInfiniteQuery({
    queryKey: dataExplorerKeys.feedback(dateParams, sourceFilter, searchText),
    queryFn: ({ pageParam }) => readProcessedPage(dateParams, sourceFilter || undefined, searchText, pageParam),
    initialPageParam: FIRST_PAGE,
    getNextPageParam: (last) => last.next,
    enabled: isConfigured && isProcessed,
  })

  // The source filter only exists on the processed tab: the S3 tab is not
  // scoped by the time range, so it must not refetch on a range change.
  const sourcesQuery = useQuery({
    queryKey: metricsKeys.sources(dateParams),
    queryFn: () => api.getSources(dateParams),
    enabled: isConfigured && isProcessed,
  })

  const refetch = () => {
    if (viewMode === 's3-raw') void s3Query.refetch()
    else void feedbackQuery.refetch()
  }

  return {
    isConfigured,
    bucketsData: bucketsQuery.data,
    s3Data: s3Query.data,
    s3Loading: s3Query.isLoading,
    feedbackData: feedbackQuery.data === undefined ? undefined : flattenPages(feedbackQuery.data.pages),
    feedbackLoading: feedbackQuery.isLoading,
    feedbackMore: {
      hasMore: feedbackQuery.hasNextPage,
      loading: feedbackQuery.isFetchingNextPage,
      load: () => { void feedbackQuery.fetchNextPage() },
    },
    // Per view, so a failed listing is told apart from an empty folder / no feedback.
    s3Failure: failedReads([s3Query]),
    feedbackFailure: failedReads([feedbackQuery]),
    sourcesData: sourcesQuery.data,
    refetch,
  }
}
