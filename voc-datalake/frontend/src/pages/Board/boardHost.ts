/**
 * @fileoverview The board-session host of the shared feature-request components: the API over the
 * board pool's token, links to `/board`, and a sign-out when the session is refused for good; and where a
 * visitor signing in lands afterwards, carried in the sign-in page's path (`/board/login/<slug>/<requestId>`).
 *
 * @module pages/Board/boardHost
 */
import { boardTransport, createFeatureRequestsApi } from '../../api/featureRequestsApi'
import { AuthError } from '../../lib/errors'
import { signOutOfBoard } from '../../store/boardSessionStore'
import { isValidSlug } from '../../api/boardFields'
import { pathOf, segmentsUnder } from '../../utils/pathPlace'
import { REQUEST_LOOKUP_SEGMENT } from '../FeatureRequests/boardPaths'
import type { FetchApi } from '../../api/requestKit'
import type { BoardAuth } from '../../services/boardAuth'
import type { BoardHost } from '../FeatureRequests/boardContext'

/** Where the standalone board lives. */
export const BOARD_PATH = '/board'
export const BOARD_LOGIN_PATH = '/board/login'

/** A request id as the boards mint it (`fr_<hex>`), loosely: word characters and dashes. */
const REQUEST_ID = /^[\w-]{1,64}$/

/**
 * Where a visitor lands after signing in, as the board path's segments: `['<slug>']`, `['<slug>', '<requestId>']`
 * or `['requests', '<requestId>']` (a request whose board is looked up), read from the sign-in page's own path
 * (`/board/login/<slug>/<requestId>`); `[]` when it names none.
 */
export function loginTarget(pathname: string): string[] {
  return (segmentsUnder(BOARD_LOGIN_PATH, pathname) ?? []).slice(0, 2)
}

/** The board path's segments a page of the standalone boards names (`/board/sales/fr_1` → `['sales', 'fr_1']`); `[]` on sign-in. */
export function boardTarget(pathname: string): string[] {
  const segments = segmentsUnder(BOARD_PATH, pathname) ?? []
  return segments[0] === 'login' ? [] : segments.slice(0, 2)
}

/** The sign-in page that lands on `target` afterwards (`['sales', 'fr_1']` → `/board/login/sales/fr_1`). */
export function boardLoginPath(target: readonly string[]): string {
  return target.length === 0 ? BOARD_LOGIN_PATH : `${BOARD_LOGIN_PATH}${pathOf(target)}`
}

/** The board slug `target` names, when a well-formed one (the slug kept with a pending sign-in, for the emailed link). */
export function targetBoard(target: readonly string[]): string | undefined {
  const [first] = target
  return first !== undefined && first !== REQUEST_LOOKUP_SEGMENT && isValidSlug(first) ? first : undefined
}

/**
 * Where a signed-in visitor lands: the board `target` names, with its request open (a board link opened signed
 * out) or, failing that, the board `remembered` names (the slug kept with the pending sign-in, for the emailed link,
 * which carries only email + code); a request known only by its id is looked up; else `/board`. Only a well-formed
 * slug and request id are followed; the board page itself says when it does not exist or is not shared.
 */
export function boardLandingPath(target: readonly string[], remembered?: string): string {
  const [first, second] = target
  const request = second !== undefined && REQUEST_ID.test(second) ? [second] : []
  if (first === REQUEST_LOOKUP_SEGMENT) return request.length === 0 ? BOARD_PATH : `${BOARD_PATH}${pathOf([first, ...request])}`
  const own = targetBoard(target)
  const board = own ?? [remembered].find((slug): slug is string => typeof slug === 'string' && isValidSlug(slug))
  if (board === undefined) return BOARD_PATH
  return `${BOARD_PATH}${pathOf([board, ...(own === undefined ? [] : request)])}`
}

export function boardHostFor(auth: BoardAuth): BoardHost {
  const transport = boardTransport((forceRefresh) => auth.getIdToken(forceRefresh))
  const guarded: FetchApi = async <T>(endpoint: string, options?: RequestInit): Promise<T> => {
    try {
      return await transport<T>(endpoint, options)
    } catch (error) {
      // A 401 that survived a refresh: the board session is over. The shell then shows sign-in.
      if (error instanceof AuthError) signOutOfBoard(auth)
      throw error
    }
  }
  return { api: createFeatureRequestsApi(guarded), basePath: BOARD_PATH, session: 'board' }
}
