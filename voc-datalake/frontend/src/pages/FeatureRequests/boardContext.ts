/**
 * @fileoverview What the shared board components need from the page that hosts them: the API over
 * the right session (app or board), where boards live for that audience, and — inside one board —
 * the board itself (its fields, statuses and template).
 *
 * The in-app pages (`/feature-requests`, `/feature-requests/:slug`) and the standalone ones
 * (`/board`, `/board/:slug`) render the same components; only these values differ between them.
 *
 * Their addresses are paths (7.49.00): a board `<boards>/<slug>`, one request open on it
 * `<boards>/<slug>/<requestId>`, a request whose board is looked up `<boards>/requests/<requestId>`
 * (the in-app citations and Insights know only the request), and in the app the Insights tab
 * `/feature-requests/insights`. `requests` and `insights` are reserved slugs
 * (lambda/shared/feature_boards_store.py). No `?request=<id>` link of before is read (a pre-release change).
 *
 * @module pages/FeatureRequests/boardContext
 */
import { createContext, useContext } from 'react'
import { appFeatureRequestsApi } from '../../api/featureRequestsApi'
import { SEEDED_BOARD } from '../../api/featureBoardsSchema'
import type { BoardViewer, FeatureRequestsApi } from '../../api/featureRequestsApi'
import type { FeatureBoard } from '../../api/featureBoardsSchema'
import { adminPath } from '../Settings/adminPaths'
import { APP_BOARDS_PATH } from './boardPaths'
import { pageHref } from '../../workspace/workspacePath'

export interface BoardHost {
  readonly api: FeatureRequestsApi
  /** Where the boards live for this audience (`/feature-requests` in the app, `/board` standalone). */
  readonly basePath: string
  /** Partitions the query cache, so an app session and a board session never share answers. */
  readonly session: 'app' | 'board'
}

/** Provided by each hosting page (`<BoardHostContext.Provider value={host}>`). */
export const BoardHostContext = createContext<BoardHost | null>(null)

export function useBoardHost(): BoardHost {
  const host = useContext(BoardHostContext)
  if (!host) throw new Error('useBoardHost needs a BoardHostProvider')
  return host
}

/** The page of one board for this audience (`/feature-requests/sales-feature-requests`). */
export function boardPagePath(host: Pick<BoardHost, 'basePath'>, boardRef: string): string {
  return `${host.basePath}/${encodeURIComponent(boardRef)}`
}

/** One request's detail on its board (`/feature-requests/sales-feature-requests/fr_1`). */
export function boardRequestPath(host: Pick<BoardHost, 'basePath'>, boardRef: string, requestId: string): string {
  return `${boardPagePath(host, boardRef)}/${encodeURIComponent(requestId)}`
}

/**
 * The absolute link that opens one request's detail on its board, for this audience: under this page's
 * `/workspace/<slug>` when it has one (`pageHref`, as a review's copied link), so it opens the same place.
 */
export function shareLinkFor(host: Pick<BoardHost, 'basePath'>, boardRef: string, requestId: string, origin = window.location.origin): string {
  return `${origin}${pageHref(boardRequestPath(host, boardRef, requestId))}`
}

/** Where admins create and configure boards (Administration → Privacy & access → Boards). */
export const BOARDS_ADMIN_PATH = adminPath({ tab: 'access', section: 'boards' })

/** The admin editor of one board. */
export function boardEditorPath(boardId: string): string {
  return adminPath({ tab: 'access', section: 'boards', item: boardId })
}

/** Board configuration is an app-pool admin's (the editor lives in the app's Administration). */
export function isAppAdmin(viewer: BoardViewer | undefined): boolean {
  return viewer !== undefined && viewer.is_admin && viewer.pool === 'app'
}

/**
 * The app-session host: in the app and on `/board` for a visitor signed in to the app. Its links
 * open the in-app pages, the ones an app user should share.
 */
export const APP_BOARD_HOST: BoardHost = {
  api: appFeatureRequestsApi,
  basePath: APP_BOARDS_PATH,
  session: 'app',
}

/**
 * The board being shown, provided by FeatureBoard. Outside one (a component rendered on its own in a
 * test) the seeded Sales board, the only board there was before boards.
 */
export const CurrentBoardContext = createContext<FeatureBoard>(SEEDED_BOARD)

export function useCurrentBoard(): FeatureBoard {
  return useContext(CurrentBoardContext)
}
