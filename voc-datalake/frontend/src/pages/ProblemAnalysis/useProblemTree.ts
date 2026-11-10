/**
 * @fileoverview The Problem Analysis tree for the page's window and filters.
 *
 * One request to `GET /feedback/problems`, which aggregates the WHOLE window on the
 * server. This replaces paging `/feedback` in the browser, which stopped at the
 * newest 2,000 reviews and so showed a fraction of every count on a large window.
 * `isPartial` is now the server's own word: true only when its walk could not read
 * the window in full (`scannedThrough` names the oldest day it did read).
 *
 * @module pages/ProblemAnalysis/useProblemTree
 */
import { useCallback } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { DateRangeParams } from '../../api/client'
import { getProblemTree } from '../../api/problemsApi'
import type { ProblemTreeResponse } from '../../api/problemsApi'
import type { ProblemFilters } from './useProblemFilters'
import { typeSelectionDims } from '../../components/ReviewTypeFilter/reviewTypeSelection'

/** How long a tree counts as fresh: the server reads a whole window per request. */
const TREE_STALE_MS = 5 * 60 * 1000

const EMPTY_TREE: ProblemTreeResponse = {
  categories: [],
  subcategories: [],
  feedbackCount: 0,
  problemCount: 0,
  problemsTruncated: false,
  isPartial: false,
  scannedThrough: null,
  typeCounts: {},
}

export interface ProblemTree extends ProblemTreeResponse {
  /** Nothing to show yet (the first request is in flight). */
  isLoading: boolean
  /**
   * The request failed. Never rendered as an empty window: an unread window is an
   * unknown one, so callers show an error rather than zeroed counts.
   */
  isError: boolean
  retry: () => void
}

type TreeFilters = Pick<ProblemFilters, 'sources' | 'usefulness' | 'category' | 'subcategory' | 'urgentOnly' | 'similarity' | 'types'>

/** The tree for the header's period and date basis (`dateParams`) and the page filters. */
export function useProblemTree(dateParams: DateRangeParams, filters: TreeFilters, apiEndpoint: string): ProblemTree {
  const { sources, usefulness, category, subcategory, urgentOnly, similarity, types } = filters
  const params = {
    ...dateParams, source: sources.length > 0 ? sources.join(',') : null, category, subcategory, urgentOnly, similarity,
    dims: typeSelectionDims(types), ...(usefulness.length > 0 ? { usefulness: usefulness.join(',') } : {}),
  }
  const query = useQuery({
    queryKey: ['feedback-problems', params],
    queryFn: () => getProblemTree(params),
    enabled: !!apiEndpoint,
    staleTime: TREE_STALE_MS,
    refetchOnWindowFocus: false,
    // A filter change keeps the current tree on screen until the new one lands.
    placeholderData: keepPreviousData,
  })
  const { refetch } = query
  const retry = useCallback(() => {
    void refetch()
  }, [refetch])
  return {
    ...(query.data ?? EMPTY_TREE),
    isLoading: query.isLoading,
    isError: query.isError,
    retry,
  }
}
