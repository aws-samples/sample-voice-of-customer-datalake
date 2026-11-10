/**
 * @fileoverview Administration → Boards over the shared board client (`api/featureRequestsApi.ts`,
 * the app session): the board list, one board, and the refetch every admin write ends with. The keys
 * are the board pages' own (`featureRequestKeys`, session `app`), so a save here also refreshes the
 * Feedback boards pages open in the same tab.
 * @module pages/Settings/boards/boardAdminQueries
 */
import { hashKey, useQuery } from '@tanstack/react-query'
import type { QueryClient } from '@tanstack/react-query'
import { appFeatureRequestsApi, featureRequestKeys } from '../../../api/featureRequestsApi'
import type { FeatureBoard } from '../../../api/featureBoardsSchema'

export const boardAdminApi = appFeatureRequestsApi

const SESSION = 'app'

export const boardAdminKeys = {
  list: () => featureRequestKeys.boards(SESSION),
  board: (boardId: string) => featureRequestKeys.board(SESSION, boardId),
}

/** Every board this admin may configure (archived ones included, flagged). */
export function useAdminBoards() {
  return useQuery({ queryKey: boardAdminKeys.list(), queryFn: () => boardAdminApi.listBoards() })
}

/** One board's configuration. */
export function useAdminBoard(boardId: string) {
  return useQuery({ queryKey: boardAdminKeys.board(boardId), queryFn: () => boardAdminApi.getBoard(boardId) })
}

type BoardList = Awaited<ReturnType<typeof boardAdminApi.listBoards>>

/** `edit` applied to the cached board list (shared by this section and the Feedback boards page), if cached. */
function editCachedList(queryClient: QueryClient, edit: (boards: readonly FeatureBoard[]) => FeatureBoard[]): void {
  queryClient.setQueryData<BoardList>(boardAdminKeys.list(), (list) => (list === undefined ? list : { ...list, boards: edit(list.boards) }))
}

/**
 * After a write: the saved board (when there is one) shows at once from the write's own answer — in
 * its own entry AND in the cached board list, which a remounting list would otherwise show stale
 * until its refetch lands — and every OTHER board answer (the lists, the board pages) refetches.
 */
export async function afterBoardWrite(queryClient: QueryClient, saved?: FeatureBoard): Promise<void> {
  if (saved === undefined) {
    await queryClient.invalidateQueries({ queryKey: featureRequestKeys.root(SESSION) })
    return
  }
  const savedKey = boardAdminKeys.board(saved.board_id)
  queryClient.setQueryData(savedKey, saved)
  editCachedList(queryClient, (boards) => (boards.some((board) => board.board_id === saved.board_id)
    ? boards.map((board) => (board.board_id === saved.board_id ? saved : board))
    : [...boards, saved]))
  const savedHash = hashKey(savedKey)
  await queryClient.invalidateQueries({
    queryKey: featureRequestKeys.root(SESSION), predicate: (query) => query.queryHash !== savedHash,
  })
}

/**
 * After a delete (the editor already closed, `&board=` cleared): the board leaves the cached list at
 * once, then every board answer refetches EXCEPT
 * the deleted board's own (its configuration and its request list, by id and by slug), which would
 * answer 404. They are left out of the refetch rather than removed: removing a query while the
 * closing editor's observer is still mounted (the URL change can commit after this callback)
 * recreates it and asks again (the 5.33.01 request-delete pattern). Unobserved, they are collected.
 */
export async function afterBoardDelete(queryClient: QueryClient, deleted: FeatureBoard): Promise<void> {
  editCachedList(queryClient, (boards) => boards.filter((board) => board.board_id !== deleted.board_id))
  const gone = new Set([deleted.board_id, deleted.slug].flatMap((ref) => [
    hashKey(featureRequestKeys.board(SESSION, ref)), hashKey(featureRequestKeys.list(SESSION, ref)),
  ]))
  await queryClient.invalidateQueries({
    queryKey: featureRequestKeys.root(SESSION), predicate: (query) => !gone.has(query.queryHash),
  })
}
