/**
 * @fileoverview Who is signed in to the feature-request board's own pool, in this tab.
 *
 * The tokens are NOT here: amazon-cognito-identity-js keeps the board session (under its own
 * `CognitoIdentityServiceProvider.<board client id>.*` keys, apart from the app pool's) and refreshes it.
 * This store only says whether there is one and whose it is, so the board shell can render.
 *
 * @module store/boardSessionStore
 */
import { create } from 'zustand'
import { createBoardAuth, type BoardAuth } from '../services/boardAuth'
import { getBoardPoolConfig } from '../runtimeConfig'

type BoardSessionStatus = 'unknown' | 'signedOut' | 'signedIn'

interface BoardSessionState {
  readonly status: BoardSessionStatus
  readonly email: string | null
  /**
   * Where the sign-in page sends the visitor once signed in (the board they opened, kept through
   * the emailed link); null = `/board`. Set together with the session so one render redirects.
   */
  readonly landing: string | null
  readonly setSignedIn: (email: string, landing?: string) => void
  readonly setSignedOut: () => void
}

export const useBoardSessionStore = create<BoardSessionState>()((set) => ({
  status: 'unknown',
  email: null,
  landing: null,
  setSignedIn: (email, landing) => set({ status: 'signedIn', email, landing: landing ?? null }),
  setSignedOut: () => set({ status: 'signedOut', email: null, landing: null }),
}))

const instance: { auth: BoardAuth | null; poolId: string } = { auth: null, poolId: '' }

/** The board sign-in service for this deployment's board pool, or null when it has none. */
export function getBoardAuth(): BoardAuth | null {
  const pool = getBoardPoolConfig()
  if (!pool) return null
  if (!instance.auth || instance.poolId !== pool.userPoolId) {
    instance.auth = createBoardAuth({ pool })
    instance.poolId = pool.userPoolId
  }
  return instance.auth
}

/** Read the cached board session into the store (on the board page's first render). */
export async function restoreBoardSession(auth: BoardAuth): Promise<void> {
  const email = await auth.currentEmail()
  const { setSignedIn, setSignedOut } = useBoardSessionStore.getState()
  if (email === null) setSignedOut()
  else setSignedIn(email)
}

/** Sign the board user out of this browser. */
export function signOutOfBoard(auth: BoardAuth): void {
  auth.signOut()
  useBoardSessionStore.getState().setSignedOut()
}
