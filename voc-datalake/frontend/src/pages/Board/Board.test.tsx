/**
 * The standalone board: its sign-in page (email, code, the emailed link in this or another
 * browser, refusals) and what `/board` does with or without a board pool or an app session.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { BoardAuthError } from '../../services/boardCognito'
import { ApiError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
import { useBoardSessionStore } from '../../store/boardSessionStore'
import { SearchProbe } from '../FeatureRequests/search-probe-fixtures'
import { APP_USER, BOARD_USER, fakeBoard, fixtureBoard, fixtureRequest } from '../FeatureRequests/feature-board-fixtures'
import type { BoardAuth, PendingSignIn } from '../../services/boardAuth'
import type { FeatureRequestsApi } from '../../api/featureRequestsApi'

const board: { auth: BoardAuth | null } = vi.hoisted(() => ({ auth: null }))
const appBoard: { api: FeatureRequestsApi | null } = vi.hoisted(() => ({ api: null }))

vi.mock('../../store/boardSessionStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../store/boardSessionStore')>(),
  getBoardAuth: () => board.auth,
}))
vi.mock('./boardHost', async (importOriginal) => {
  const original = await importOriginal<typeof import('./boardHost')>()
  return { ...original, boardHostFor: () => ({ api: appBoard.api, basePath: '/board', session: 'board' }) }
})
vi.mock('../FeatureRequests/boardContext', async (importOriginal) => {
  const original = await importOriginal<typeof import('../FeatureRequests/boardContext')>()
  return { ...original, get APP_BOARD_HOST() { return { api: appBoard.api, basePath: '/feature-requests', session: 'app' } } }
})
import Board from './Board'

const PENDING: PendingSignIn = { email: 'dana@example.com', step: 'otp', session: 'otp-session', expiresAt: Date.now() + 60_000 }

function fakeAuth(pending: PendingSignIn | null = null, expiredFor: string | null = null) {
  const auth = {
    mode: 'email_otp',
    requestCode: vi.fn<BoardAuth['requestCode']>(() => Promise.resolve(PENDING)),
    pending: vi.fn<BoardAuth['pending']>(() => pending),
    pendingExpiredFor: vi.fn<BoardAuth['pendingExpiredFor']>((email) => email === expiredFor),
    verifyCode: vi.fn<BoardAuth['verifyCode']>(() => Promise.resolve({ status: 'signed_in', email: 'dana@example.com' })),
    cancelPending: vi.fn(),
    getIdToken: vi.fn<BoardAuth['getIdToken']>(() => Promise.resolve('token')),
    currentEmail: vi.fn<BoardAuth['currentEmail']>(() => Promise.resolve(null)),
    signOut: vi.fn(),
  } satisfies BoardAuth
  board.auth = auth
  return auth
}

function PathProbe() {
  return <output data-testid="path">{useLocation().pathname}</output>
}

function renderAt(entry: string) {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/board/*" element={<Board />} />
        <Route path="/feature-requests" element={<p>In-app board</p>} />
        <Route path="/feature-requests/:slug" element={<p>In-app board page</p>} />
      </Routes>
      <SearchProbe />
      <PathProbe />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  board.auth = null
  appBoard.api = fakeBoard(BOARD_USER, [fixtureRequest('fr_1', { title: 'Single sign-on' })]).api
  useBoardSessionStore.setState({ status: 'unknown', email: null })
})

afterEach(() => {
  useAuthStore.getState().logout()
})

/** The sign-in page's two steps: the email, then the emailed code. */
async function signInWithCode(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Work email'), 'dana@example.com')
  await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
  await user.type(await screen.findByLabelText('Code from the email'), '12345678')
  await user.click(screen.getByRole('button', { name: 'Sign in' }))
}

describe('board sign-in', () => {
  it('emails a code, then signs in with it and opens the board', async () => {
    const user = userEvent.setup()
    const auth = fakeAuth()
    renderAt('/board/login')
    await signInWithCode(user)
    expect(auth.requestCode).toHaveBeenCalledWith('dana@example.com', { board: undefined, returnTo: undefined })
    expect(auth.verifyCode).toHaveBeenCalledWith('12345678', undefined)
    expect(await screen.findByRole('button', { name: 'Single sign-on' })).toBeInTheDocument()
  })

  it('finishes by itself when the emailed link opens in the browser that asked', async () => {
    const auth = fakeAuth(PENDING)
    renderAt('/board/login?email=dana%40example.com&code=12345678')
    await waitFor(() => expect(auth.verifyCode).toHaveBeenCalledWith('12345678', 'dana@example.com'))
    expect(await screen.findByText('dana@example.com')).toBeInTheDocument()
  })

  it('drops the used code from the address once the emailed link signed in, keeping the shared request', async () => {
    fakeAuth(PENDING)
    renderAt('/board/login?email=dana%40example.com&code=12345678&request=fr_1')
    expect(await screen.findByText('dana@example.com')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent('?request=fr_1'))
    expect(screen.getByTestId('search')).not.toHaveTextContent(/code|email/)
  })

  it('signs out of a board opened with a stale link without the different-browser warning', async () => {
    const user = userEvent.setup()
    fakeAuth()
    useBoardSessionStore.setState({ status: 'signedIn', email: 'dana@example.com' })
    renderAt('/board?email=dana%40example.com&code=12345678&request=fr_1')
    await user.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByLabelText('Work email')).toBeInTheDocument()
    expect(screen.queryByText(/opened in a different browser/)).not.toBeInTheDocument()
    expect(screen.getByTestId('search')).toHaveTextContent('?request=fr_1')
  })

  it('cleans the link out of the address even when it opens in another browser', async () => {
    fakeAuth(null)
    renderAt('/board/login?email=dana%40example.com&code=12345678')
    expect(await screen.findByText(/opened in a different browser/)).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement())
  })

  it('explains what to do when the link opens in another browser', async () => {
    const auth = fakeAuth(null)
    renderAt('/board/login?email=dana%40example.com&code=12345678')
    expect(await screen.findByText(/opened in a different browser/)).toBeInTheDocument()
    expect(screen.getByLabelText('Work email')).toHaveValue('dana@example.com')
    expect(auth.verifyCode).not.toHaveBeenCalled()
  })

  it('says the sign-in expired when a late link opens in the browser that asked', async () => {
    const auth = fakeAuth(null, 'dana@example.com')
    renderAt('/board/login?email=dana%40example.com&code=12345678')
    expect(await screen.findByText(/This sign-in expired/)).toBeInTheDocument()
    expect(screen.queryByText(/opened in a different browser/)).not.toBeInTheDocument()
    expect(screen.getByLabelText('Work email')).toHaveValue('dana@example.com')
    expect(auth.verifyCode).not.toHaveBeenCalled()
  })

  it('says when the email domain is not allowed', async () => {
    const user = userEvent.setup()
    const auth = fakeAuth()
    auth.requestCode.mockRejectedValue(new BoardAuthError('domain_not_allowed'))
    renderAt('/board/login')
    await user.type(await screen.findByLabelText('Work email'), 'pat@elsewhere.example')
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))
    expect(await screen.findByText(/domain is not allowed/)).toBeInTheDocument()
  })

  it('keeps the code step after a wrong code', async () => {
    const user = userEvent.setup()
    const auth = fakeAuth(PENDING)
    auth.verifyCode.mockRejectedValue(new BoardAuthError('wrong_code'))
    renderAt('/board/login')
    await user.type(await screen.findByLabelText('Code from the email'), '00000000')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(await screen.findByText(/That code is not right/)).toBeInTheDocument()
    expect(screen.getByLabelText('Code from the email')).toBeInTheDocument()
  })

  it('asks for the second code when the first one only confirmed the account', async () => {
    const user = userEvent.setup()
    const auth = fakeAuth()
    auth.verifyCode.mockResolvedValueOnce({ status: 'next', pending: { ...PENDING, step: 'otp' } })
    renderAt('/board/login')
    await signInWithCode(user)
    expect(await screen.findByText(/Your email is confirmed\. We sent one more code/)).toBeInTheDocument()
    expect(screen.getByLabelText('Code from the email')).toHaveValue('')
    await user.type(screen.getByLabelText('Code from the email'), '87654321')
    await user.click(screen.getByRole('button', { name: 'Sign in' }))
    expect(auth.verifyCode).toHaveBeenLastCalledWith('87654321', undefined)
    expect(await screen.findByRole('button', { name: 'Single sign-on' })).toBeInTheDocument()
  })

  it('sends a signed-out visitor of /board to sign-in, keeping the shared request', async () => {
    fakeAuth()
    renderAt('/board?request=fr_1')
    expect(await screen.findByLabelText('Work email')).toBeInTheDocument()
    expect(screen.getByTestId('search')).toHaveTextContent('?request=fr_1')
  })
})

describe('the board without a board pool', () => {
  it('explains the board is not enabled to a visitor without an app session', () => {
    renderAt('/board')
    expect(screen.getByRole('heading', { name: 'Feedback boards are not enabled' })).toBeInTheDocument()
  })

  it('sends an app user to the in-app page', () => {
    useAuthStore.getState().setUser({ username: 'rui', email: APP_USER.email, groups: [] })
    renderAt('/board?request=fr_1')
    expect(screen.getByText('In-app board')).toBeInTheDocument()
  })
})

describe('an app user on /board', () => {
  it('uses the app session instead of asking for a board sign-in', async () => {
    fakeAuth()
    useAuthStore.getState().setUser({ username: 'rui', email: APP_USER.email, groups: [] })
    renderAt('/board')
    expect(await screen.findByRole('button', { name: 'Single sign-on' })).toBeInTheDocument()
    expect(screen.getByText(APP_USER.email)).toBeInTheDocument()
  })
})

describe('the standalone boards', () => {
  const SALES = fixtureBoard('sales', { board_id: 'brd_sales', slug: 'sales-feature-requests', name: 'Sales feature requests' })
  const BETA = fixtureBoard('beta', { name: 'Beta feedback' })

  /** A signed-in board session whose API lists `boards` and answers a board's requests with `board`. */
  function signedIn(boards: readonly typeof SALES[], board = boards[0]) {
    fakeAuth()
    useBoardSessionStore.setState({ status: 'signedIn', email: BOARD_USER.email })
    const fake = fakeBoard(BOARD_USER, [fixtureRequest('fr_1', { title: 'Single sign-on' })], {}, { boards, board })
    appBoard.api = fake.api
    return fake
  }

  it('opens the only board this person may use directly', async () => {
    signedIn([SALES])
    renderAt('/board')
    expect(await screen.findByRole('heading', { name: 'Sales feature requests' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement())
  })

  it('lists the boards when there are several', async () => {
    signedIn([SALES, BETA])
    renderAt('/board')
    expect(await screen.findByRole('link', { name: 'Open Beta feedback' })).toHaveAttribute('href', '/board/beta-board')
    expect(screen.getByRole('link', { name: 'Open Sales feature requests' })).toBeInTheDocument()
  })

  it('opens a pre-boards /board?request= link on the request\'s board', async () => {
    signedIn([SALES, BETA])
    renderAt('/board?request=fr_1')
    expect(await screen.findByRole('dialog', { name: 'Single sign-on' })).toBeInTheDocument()
    expect(screen.getByTestId('search')).toHaveTextContent('?request=fr_1')
  })

  it('says a board that is not shared with this person does not exist', async () => {
    const fake = signedIn([SALES])
    vi.mocked(fake.api.listRequests).mockRejectedValue(new ApiError(404, 'Board not found'))
    renderAt('/board/someone-elses-board')
    expect(await screen.findByRole('heading', { name: 'Board not found' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Back to the boards' })).toHaveAttribute('href', '/board')
  })

  it('says in words when the daily posting limit is reached', async () => {
    const user = userEvent.setup()
    const fake = signedIn([BETA])
    vi.mocked(fake.api.createRequest).mockRejectedValue(new ApiError(429, 'rate_limited'))
    renderAt('/board/beta-board')
    await user.click(await screen.findByRole('button', { name: 'New request' }))
    await user.type(screen.getByLabelText('Title'), 'Cart total is wrong')
    await user.type(screen.getByLabelText('Description (optional)'), 'It adds the shipping twice.')
    await user.type(screen.getByLabelText('Area (required)'), 'Cart')
    await user.selectOptions(screen.getByLabelText('What happened (required)'), 'broken')
    await user.type(screen.getByLabelText('Your name'), 'Sam')
    await user.click(screen.getByRole('button', { name: 'Add request' }))
    expect(await screen.findByText('You have reached today’s posting limit on this board. Try again tomorrow.')).toBeInTheDocument()
  })

  it('signs a visitor of a board link in and brings them back to that board', async () => {
    const user = userEvent.setup()
    const auth = fakeAuth()
    appBoard.api = fakeBoard(BOARD_USER, [], {}, { boards: [SALES, BETA], board: BETA }).api
    renderAt('/board/beta-board')
    expect(await screen.findByLabelText('Work email')).toBeInTheDocument()
    expect(screen.getByTestId('search')).toHaveTextContent('?board=beta-board')
    await signInWithCode(user)
    // The board rides along with the pending sign-in, for the emailed link (which carries only email + code).
    expect([auth.requestCode.mock.calls[0], auth.verifyCode.mock.calls[0]]).toStrictEqual([
      ['dana@example.com', { board: 'beta-board', returnTo: undefined }], ['12345678', undefined],
    ])
    expect(await screen.findByRole('heading', { name: 'Beta feedback' })).toBeInTheDocument()
  })

  it('opens the remembered board when the emailed link (email + code only) signs in', async () => {
    fakeAuth({ ...PENDING, board: 'beta-board' })
    appBoard.api = fakeBoard(BOARD_USER, [], {}, { boards: [SALES, BETA], board: BETA }).api
    renderAt('/board/login?email=dana%40example.com&code=12345678')
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/board/beta-board'))
    expect(await screen.findByRole('button', { name: 'New request' })).toBeInTheDocument()
    expect(screen.getByTestId('search')).not.toHaveTextContent(/code|email/)
  })

  it('sends an app user without a board pool to the same board in the app', () => {
    useAuthStore.getState().setUser({ username: 'rui', email: APP_USER.email, groups: [] })
    renderAt('/board/beta-board?request=fr_1')
    expect(screen.getByText('In-app board page')).toBeInTheDocument()
    expect(screen.getByTestId('search')).toHaveTextContent('?request=fr_1')
  })
})
