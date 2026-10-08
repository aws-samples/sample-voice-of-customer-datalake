/**
 * @fileoverview "Load failed" vs "empty", for pages fed by several queries.
 *
 * A read that errored with nothing cached has no data, and a page that maps
 * `data ?? []` then renders its EMPTY state — a false "you have no feedback /
 * no sources" exactly when the user cannot check (offline, 500, 403). Pages ask
 * this helper whether that is what happened, and render `components/LoadFailed`
 * with its `retry` instead.
 *
 * @module utils/failedReads
 */

/** Structural subset of a TanStack query result: enough to tell "failed" from "empty" and retry. */
export interface RetryableRead {
  data: unknown
  isError: boolean
  isFetching: boolean
  refetch: () => Promise<unknown>
}

export interface FailedReads {
  /** At least one read errored and has no data to show. */
  loadFailed: boolean
  /** A refetch of one of those reads is in flight. */
  retrying: boolean
  /** Refetch just the failed reads. */
  retry: () => void
}

/** Nothing failed — the default for a component told about failures optionally. */
export const NO_FAILED_READS: FailedReads = { loadFailed: false, retrying: false, retry: () => undefined }

/** Whether any of `reads` failed with no data, and how to retry just those. */
export function failedReads(reads: readonly RetryableRead[]): FailedReads {
  const failed = reads.filter((read) => read.isError && read.data === undefined)
  return {
    loadFailed: failed.length > 0,
    retrying: failed.some((read) => read.isFetching),
    retry: () => {
      for (const read of failed) void read.refetch()
    },
  }
}
