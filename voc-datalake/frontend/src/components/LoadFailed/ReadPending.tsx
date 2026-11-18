/**
 * @fileoverview A read with no data yet: a skeleton (its height the caller's, named for a screen reader) while it is on
 * its way, else its failure with Retry (LoadFailed). For a section that has nothing to show until its read answers.
 *
 * @module components/LoadFailed/ReadPending
 */
import clsx from 'clsx'
import LoadFailed from './LoadFailed'
import type { UseQueryResult } from '@tanstack/react-query'

export default function ReadPending({ read, loading, failed, skeleton }: Readonly<{
  read: UseQueryResult
  /** The skeleton's name while it loads. */
  loading: string
  /** What failed (LoadFailed's message). */
  failed: string
  /** The skeleton's height (`h-24`). */
  skeleton: string
}>) {
  if (read.isLoading) return <div className={clsx('skeleton', skeleton)} role="status" aria-label={loading} />
  return <LoadFailed message={failed} onRetry={() => void read.refetch()} retrying={read.isFetching} />
}
