/**
 * @fileoverview A list the API serves a page at a time with `next_cursor` (the members of a workspace, the platform
 * console's workspaces): an infinite query from the first page, and every row read so far in the server's order.
 *
 * @module hooks/useCursorPages
 */
import { useInfiniteQuery } from '@tanstack/react-query'
import type { InfiniteData, QueryKey } from '@tanstack/react-query'
import type { CursorPage } from '../api/cursorPage'

export function useCursorPages<Row>(queryKey: QueryKey, fetchPage: (cursor: string | null) => Promise<CursorPage<Row>>) {
  // The page param is the cursor: null for the first page (typed here, so no assertion is needed).
  const query = useInfiniteQuery<CursorPage<Row>, Error, InfiniteData<CursorPage<Row>>, QueryKey, string | null>({
    queryKey,
    queryFn: ({ pageParam }) => fetchPage(pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  })
  const rows: Row[] = query.data?.pages.flatMap((page) => page.rows) ?? []
  return { query, rows }
}

export type CursorPagesQuery = ReturnType<typeof useCursorPages>['query']
