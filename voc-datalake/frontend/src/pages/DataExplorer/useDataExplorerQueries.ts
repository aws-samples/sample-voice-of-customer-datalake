/**
 * @fileoverview Custom hooks for Data Explorer queries.
 * @module pages/DataExplorer/useDataExplorerQueries
 */

import { useQuery } from '@tanstack/react-query'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { normalizeBuckets, normalizeS3Listing } from './dataExplorerSchema'
import { failedReads } from '../../utils/failedReads'

type ViewMode = 's3-raw' | 'dynamodb-processed'

// Wire-boundary normalization (dataExplorerSchema.ts): components never trust a
// response to match its declared type. Module-level so `select` keeps a stable
// identity — TanStack Query then runs it once per response, not once per render.
const selectBuckets = (raw: unknown) => ({ buckets: normalizeBuckets(raw) })

export function useDataExplorerQueries(
  viewMode: ViewMode,
  selectedBucket: string,
  s3Path: string[],
  sourceFilter: string
) {
  const { timeRange, customDays, dateBasis, config } = useConfigStore()
  const dateParams = getDateRangeParams(timeRange, customDays, dateBasis)
  const isConfigured = !!config.apiEndpoint

  const bucketsQuery = useQuery({
    queryKey: ['data-explorer-buckets'],
    queryFn: () => api.getDataExplorerBuckets(),
    select: selectBuckets,
    enabled: isConfigured,
  })

  const s3Query = useQuery({
    queryKey: ['data-explorer-s3', selectedBucket, s3Path.join('/')],
    queryFn: () => api.getDataExplorerS3(s3Path.join('/'), selectedBucket),
    select: normalizeS3Listing,
    enabled: isConfigured && viewMode === 's3-raw',
  })

  const feedbackQuery = useQuery({
    queryKey: ['data-explorer-feedback', dateParams, sourceFilter],
    queryFn: () => api.getFeedback({ ...dateParams, source: sourceFilter || undefined, limit: 100 }),
    enabled: isConfigured && viewMode === 'dynamodb-processed',
  })

  const sourcesQuery = useQuery({
    queryKey: ['sources', dateParams],
    queryFn: () => api.getSources(dateParams),
    enabled: isConfigured,
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
    feedbackData: feedbackQuery.data,
    feedbackLoading: feedbackQuery.isLoading,
    // Per view, so a failed listing is told apart from an empty folder / no feedback.
    s3Failure: failedReads([s3Query]),
    feedbackFailure: failedReads([feedbackQuery]),
    sourcesData: sourcesQuery.data,
    refetch,
  }
}
