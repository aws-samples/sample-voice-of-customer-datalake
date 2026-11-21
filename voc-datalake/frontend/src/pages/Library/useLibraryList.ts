/**
 * @fileoverview The Library list as the page reads it: the filters' pages (`next_cursor`, "Load more"), every tag in
 * use, and a refetch every few seconds while an item on screen is still being uploaded or read (its status moves on
 * in the projects assist worker, which tells nobody); never for an item the server reads as `stale` (an extraction
 * that outlived its worker, or an upload whose link expired).
 *
 * @module pages/Library/useLibraryList
 */
import { useMemo } from 'react'
import { useInfiniteQuery } from '@tanstack/react-query'
import { libraryApi, libraryKeys } from '../../api/libraryApi'
import type { LibraryListQuery } from '../../api/libraryApi'
import type { LibraryItem, LibraryPage } from '../../api/librarySchema'

/** How often a list with an item in flight is read again. */
export const IN_FLIGHT_REFETCH_MS = 4000

/**
 * Whether an item's status can still move on by itself: pending or extracting, and not yet stale (a pending item whose
 * PUT's link expired gets no file; an extraction whose worker is over goes no further).
 */
export const isItemInFlight = (item: Pick<LibraryItem, 'status' | 'stale'>): boolean =>
  (item.status === 'pending' || item.status === 'extracting') && item.stale !== true

/** Whether a writer may read the item again: it failed, or its extraction outlived the worker (`stale`). */
export const isItemRetryable = (item: Pick<LibraryItem, 'status' | 'stale'>): boolean =>
  item.status === 'failed' || (item.status === 'extracting' && item.stale === true)

function anyInFlight(pages: readonly LibraryPage[] | undefined): boolean {
  return (pages ?? []).some((page) => page.items.some(isItemInFlight))
}

export function useLibraryList(query: LibraryListQuery) {
  const pages = useInfiniteQuery({
    queryKey: libraryKeys.list(query),
    queryFn: ({ pageParam }) => libraryApi.list({ ...query, ...(pageParam === '' ? {} : { cursor: pageParam }) }),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: (state) => (anyInFlight(state.state.data?.pages) ? IN_FLIGHT_REFETCH_MS : false),
  })
  const items = useMemo(() => {
    const all = pages.data?.pages.flatMap((page) => page.items) ?? []
    return [...new Map(all.map((item) => [item.item_id, item])).values()]
  }, [pages.data])
  const first = pages.data?.pages[0]
  return { pages, items, tags: first?.tags ?? [], total: first?.total ?? 0 }
}
