/**
 * @fileoverview The states of a list read a page at a time (`hooks/useCursorPages`): loading, a failed first read
 * (said in words, with Try again, or the caller's own failure), nothing to list, or the rows with "Show more" while
 * the server has another page, and an alert beside it when that page could not be read, or above the rows when
 * reading them again failed.
 *
 * @module components/CursorPagesList
 */
import type { ReactNode } from 'react'
import { Loader2 } from 'lucide-react'
import LoadFailed from '../LoadFailed/LoadFailed'
import type { CursorPagesQuery } from '../../hooks/useCursorPages'

interface CursorPagesListProps {
  readonly query: CursorPagesQuery
  readonly count: number
  readonly copy: {
    readonly loading: string
    readonly loadFailed: string
    readonly more: string
    /** Said when a later page could not be read (beside Show more, which tries again). */
    readonly moreFailed: string
    /** Said above rows already shown when reading them again failed (with Try again). */
    readonly refreshFailed: string
    readonly empty?: string
  }
  /** What to show for a failed read (a refusal) instead of Try again or `copy.moreFailed`, or null for the default. */
  readonly failure?: ReactNode
  readonly children: ReactNode
}

export default function CursorPagesList({ query, count, copy, failure = null, children }: CursorPagesListProps) {
  if (query.isPending) {
    return (
      <p className="flex items-center gap-2 py-4 text-sm text-muted">
        <Loader2 size={16} className="animate-spin" aria-hidden="true" />{copy.loading}
      </p>
    )
  }
  if (query.isError && count === 0) return <ReadFailed query={query} failure={failure} message={copy.loadFailed} />
  if (count === 0 && copy.empty !== undefined) return <p className="text-sm text-muted">{copy.empty}</p>
  // A failed reload of rows already shown (after a write, a focus refetch): say they may be out of date.
  const refreshFailed = query.isRefetchError && !query.isFetchNextPageError
  return (
    <>
      {refreshFailed ? <ReadFailed query={query} failure={failure} message={copy.refreshFailed} /> : null}
      {children}
      {query.hasNextPage ? <ShowMore query={query} failure={failure} copy={copy} /> : null}
    </>
  )
}

/** A failed read with Try again (it reads the list again), or the caller's own failure. */
function ReadFailed({ query, failure, message }: Readonly<{ query: CursorPagesQuery; failure: ReactNode; message: string }>) {
  if (failure !== null) return <>{failure}</>
  return <LoadFailed onRetry={() => { void query.refetch() }} retrying={query.isFetching} message={message} />
}

/** Show more, and beside it, when the next page could not be read, why (the caller's own failure, or `moreFailed`). */
function ShowMore({ query, failure, copy }: Readonly<{
  query: CursorPagesQuery
  failure: ReactNode
  copy: Readonly<{ more: string; moreFailed: string }>
}>) {
  const alert = failure ?? <p role="alert" className="text-sm text-danger">{copy.moreFailed}</p>
  return (
    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
      <button type="button" className="btn btn-secondary self-start" disabled={query.isFetchingNextPage} onClick={() => { void query.fetchNextPage() }}>
        {copy.more}
      </button>
      {query.isFetchNextPageError ? alert : null}
    </div>
  )
}
