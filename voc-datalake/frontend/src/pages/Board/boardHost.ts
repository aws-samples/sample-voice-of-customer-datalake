/**
 * @fileoverview The board-session host of the shared feature-request components: the API over the
 * board pool's token, links to `/board`, and a sign-out when the session is refused for good.
 *
 * @module pages/Board/boardHost
 */
import { boardTransport, createFeatureRequestsApi } from '../../api/featureRequestsApi'
import { AuthError } from '../../lib/errors'
import { signOutOfBoard } from '../../store/boardSessionStore'
import { isValidSlug } from '../../api/boardFields'
import type { FetchApi } from '../../api/requestKit'
import type { BoardAuth } from '../../services/boardAuth'
import type { BoardHost } from '../FeatureRequests/boardContext'

/** Where the standalone board lives. */
export const BOARD_PATH = '/board'
export const BOARD_LOGIN_PATH = '/board/login'

/** The query parameter that carries a board's slug through sign-in (`/board/login?board=<slug>`). */
export const BOARD_PARAM = 'board'

/**
 * Where a signed-in visitor lands: `/board/<slug>` when `?board=` names one (a board link opened
 * signed out) or, failing that, `remembered` does (the slug kept with the pending sign-in, for the
 * emailed link, which carries only email + code); else `/board`. Only a well-formed slug is
 * followed; the board page itself says when it does not exist or is not shared. A shared
 * `?request=` is kept.
 */
export function boardLandingPath(params: URLSearchParams, remembered?: string): string {
  const board = [params.get(BOARD_PARAM), remembered].find((slug): slug is string => typeof slug === 'string' && isValidSlug(slug))
  const request = params.get('request')
  const path = board === undefined ? BOARD_PATH : `${BOARD_PATH}/${encodeURIComponent(board)}`
  return request === null ? path : `${path}?${new URLSearchParams({ request }).toString()}`
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
