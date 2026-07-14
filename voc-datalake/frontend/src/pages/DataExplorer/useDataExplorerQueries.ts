/**
 * @fileoverview Custom hooks for Data Explorer queries.
 * @module pages/DataExplorer/useDataExplorerQueries
 */

import { useQuery } from '@tanstack/react-query'
import { api, getDateRangeParams } from '../../api/client'
import { useConfigStore } from '../../store/configStore'

type ViewMode = 's3-raw' | 'dynamodb-processed'

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
    enabled: isConfigured,
  })

  const s3Query = useQuery({
    queryKey: ['data-explorer-s3', selectedBucket, s3Path.join('/')],
    queryFn: () => api.getDataExplorerS3(s3Path.join('/'), selectedBucket),
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
    if (viewMode === 's3-raw') s3Query.refetch()
    else feedbackQuery.refetch()
  }

  return {
    isConfigured,
    bucketsData: bucketsQuery.data,
    s3Data: s3Query.data,
    s3Loading: s3Query.isLoading,
    feedbackData: feedbackQuery.data,
    feedbackLoading: feedbackQuery.isLoading,
    sourcesData: sourcesQuery.data,
    refetch,
  }
}
