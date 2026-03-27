/**
 * @fileoverview Custom hooks for Data Explorer queries.
 * @module pages/DataExplorer/useDataExplorerQueries
 */

import { useQuery } from '@tanstack/react-query'
import { getDaysFromRange } from '../../api/baseUrl'
import { api } from '../../api/client'
import { dataExplorerApi } from '../../api/dataExplorerApi'
import { useConfigStore } from '../../store/configStore'

type ViewMode = 's3-raw' | 'dynamodb-processed' | 'dynamodb-categories'

export function useDataExplorerQueries(
  viewMode: ViewMode,
  selectedBucket: string,
  s3Path: string[],
  sourceFilter: string,
) {
  const {
    timeRange, customDateRange, config,
  } = useConfigStore()
  const days = getDaysFromRange(timeRange, customDateRange)
  const isConfigured = config.apiEndpoint !== ''

  const bucketsQuery = useQuery({
    queryKey: ['data-explorer-buckets'],
    queryFn: () => dataExplorerApi.getDataExplorerBuckets(),
    enabled: isConfigured,
  })

  const s3Query = useQuery({
    queryKey: ['data-explorer-s3', selectedBucket, s3Path.join('/')],
    queryFn: () => dataExplorerApi.getDataExplorerS3(s3Path.join('/'), selectedBucket),
    enabled: isConfigured && viewMode === 's3-raw',
  })

  const feedbackQuery = useQuery({
    queryKey: ['data-explorer-feedback', days, sourceFilter],
    queryFn: () => api.getFeedback({
      days,
      source: sourceFilter === '' ? undefined : sourceFilter,
      limit: 100,
    }),
    enabled: isConfigured && viewMode === 'dynamodb-processed',
  })

  const categoriesQuery = useQuery({
    queryKey: ['data-explorer-categories', days, sourceFilter],
    queryFn: () => api.getCategories(days, sourceFilter === '' ? undefined : sourceFilter),
    enabled: isConfigured && viewMode === 'dynamodb-categories',
  })

  const sourcesQuery = useQuery({
    queryKey: ['sources', days],
    queryFn: () => api.getSources(days),
    enabled: isConfigured,
  })

  const refetch = () => {
    if (viewMode === 's3-raw') void s3Query.refetch()
    else if (viewMode === 'dynamodb-processed') void feedbackQuery.refetch()
    else void categoriesQuery.refetch()
  }

  return {
    isConfigured,
    bucketsData: bucketsQuery.data,
    s3Data: s3Query.data,
    s3Loading: s3Query.isLoading,
    s3Error: s3Query.error,
    feedbackData: feedbackQuery.data,
    feedbackLoading: feedbackQuery.isLoading,
    feedbackError: feedbackQuery.error,
    categoriesData: categoriesQuery.data,
    categoriesLoading: categoriesQuery.isLoading,
    categoriesError: categoriesQuery.error,
    sourcesData: sourcesQuery.data,
    refetch,
  }
}
