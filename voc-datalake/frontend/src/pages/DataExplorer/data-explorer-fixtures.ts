/**
 * @fileoverview Test fixture: what a mocked `useDataExplorerQueries` returns (empty listings, one bucket).
 * Shared by the Data Explorer page specs so each mock states only what it changes.
 *
 * @module pages/DataExplorer/data-explorer-fixtures
 */

export type ExplorerView = 's3' | 'feedback'

export interface ListingFailure {
  readonly loadFailed: boolean
  readonly retrying: boolean
  readonly retry: () => void
}

const NO_FAILURE: ListingFailure = { loadFailed: false, retrying: false, retry: () => {} }

/** The hook's result; `failure` names each view's listing state (none failed by default). */
export function dataExplorerQueriesResult(
  isConfigured = true,
  failure: (view: ExplorerView) => ListingFailure = () => NO_FAILURE,
) {
  return {
    isConfigured,
    s3Data: { folders: [], files: [] },
    s3Loading: false,
    feedbackData: { items: [], total: 0, isLowerBound: false },
    feedbackLoading: false,
    s3Failure: failure('s3'),
    feedbackFailure: failure('feedback'),
    bucketsData: { buckets: [{ id: 'raw-data', label: 'Raw Data' }] },
    sourcesData: { sources: {} },
    refetch: () => {},
  }
}
