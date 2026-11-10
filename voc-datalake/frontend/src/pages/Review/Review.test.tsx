/**
 * `/review/:shareId`, outside the app's protected layout: a malformed link says it is gone, an
 * app user reviews with the app session, anyone else signs in with the board pool's emailed
 * code inline (worded by the pool's mode), and a signed-in reviewer reads the newest version and
 * comments. A revoked, expired or not-for-you link says one "not available".
 */
import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import { stubRangeLayout } from '@test/stubRangeLayout'
import { ApiError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
import { useBoardSessionStore } from '../../store/boardSessionStore'
import type { BoardAuth } from '../../services/boardAuth'

const SHARE_ID = `shr_${'c'.repeat(32)}`

type Transport = (endpoint: string, options?: RequestInit) => Promise<unknown>

/** The board pool's sign-in (null = no pool on this deployment). */
const pool = vi.hoisted((): { auth: BoardAuth | null } => ({ auth: null }))
const appFetch = vi.fn<Transport>()
const boardFetch = vi.fn<Transport>()

vi.mock('../../store/boardSessionStore', async (importOriginal) => {
  const store = await importOriginal<typeof import('../../store/boardSessionStore')>()
  return { ...store, getBoardAuth: () => pool.auth }
})
vi.mock('../../api/featureRequestsApi', () => ({
  appTransport: (endpoint: string, options?: RequestInit) => appFetch(endpoint, options),
  boardTransport: () => (endpoint: string, options?: RequestInit) => boardFetch(endpoint, options),
}))

const { default: Review } = await import('./Review')

const ANSWER = {
  share: { share_id: SHARE_ID, document_type: 'prfaq', expires_at: '2026-11-27T10:00:00Z' },
  document: { document_id: 'doc_2', version: 2, title: 'Faster refunds', content: 'Customers wait two weeks for a refund.' },
  threads: [{
    comment_id: 'c1', document_id: 'doc_2', version: 2, text: 'Which refund method?', anchor: null, status: 'open',
    flagged: false, created_at: '2026-10-28T10:00:00Z', author: { kind: 'reviewer', name: 'sam@example.com' }, replies: [],
    from_review_link: true,
  }],
  viewer: { email: 'sam@example.com', name: '' },
}

function fakeAuth(mode: BoardAuth['mode'] = 'email_otp'): BoardAuth {
  const auth: BoardAuth = {
    mode,
    requestCode: vi.fn(),
    pending: vi.fn(() => null),
    pendingExpiredFor: vi.fn(() => false),
    verifyCode: vi.fn(),
    cancelPending: vi.fn(),
    getIdToken: vi.fn(() => Promise.resolve('token')),
    currentEmail: vi.fn(() => Promise.resolve(null)),
    signOut: vi.fn(),
  }
  pool.auth = auth
  return auth
}

function renderAt(shareId: string) {
  return renderWithQueryClient(
    <MemoryRouter initialEntries={[`/review/${shareId}`]}>
      <Routes><Route path="/review/:shareId" element={<Review />} /></Routes>
    </MemoryRouter>,
  )
}

beforeAll(() => stubRangeLayout())

beforeEach(() => {
  appFetch.mockReset()
  boardFetch.mockReset()
  pool.auth = null
  useAuthStore.getState().logout()
  useBoardSessionStore.setState({ status: 'unknown', email: null })
  boardFetch.mockImplementation((_endpoint, options) =>
    Promise.resolve(options?.method === 'POST' ? { thread: ANSWER.threads[0] } : ANSWER))
})

describe('the review page', () => {
  it('says a malformed link is not available, without calling anything', () => {
    fakeAuth()
    renderAt('not-a-share')

    expect(screen.getByText(/This review link has expired, was turned off/)).toBeInTheDocument()
    expect([appFetch.mock.calls.length, boardFetch.mock.calls.length]).toStrictEqual([0, 0])
  })

  it('says review is not available when the deployment has no board pool and no app session', () => {
    renderAt(SHARE_ID)

    expect(screen.getByText('Document review is not available on this deployment.')).toBeInTheDocument()
  })

  it('reviews with the app session for a signed-in app user', async () => {
    appFetch.mockResolvedValue(ANSWER)
    useAuthStore.getState().setUser({ username: 'rui', email: 'rui@example.com', groups: [] })
    renderAt(SHARE_ID)

    expect(await screen.findByRole('heading', { name: 'Faster refunds' })).toBeInTheDocument()
    expect(appFetch).toHaveBeenCalledWith(`/review/${SHARE_ID}`, undefined)
  })

  it('asks a signed-out visitor to sign in inline, worded for an SES pool', () => {
    fakeAuth('email_otp')
    useBoardSessionStore.setState({ status: 'signedOut', email: null })
    renderAt(SHARE_ID)

    expect(screen.getByRole('heading', { name: 'Sign in to review' })).toBeInTheDocument()
    expect(screen.getByText('Enter your email address. We will send you a sign-in code and a link.')).toBeInTheDocument()
  })

  it("names Cognito's sender on a pool without SES", () => {
    fakeAuth('code')
    useBoardSessionStore.setState({ status: 'signedOut', email: null })
    renderAt(SHARE_ID)

    expect(screen.getByText(/no-reply@verificationemail\.com/)).toBeInTheDocument()
  })

  it('sends the review link along with the sign-in, so the code returns here', async () => {
    const auth = fakeAuth()
    vi.mocked(auth.requestCode).mockResolvedValue({ email: 'sam@example.com', step: 'confirm', session: '', expiresAt: Date.now() + 60_000 })
    useBoardSessionStore.setState({ status: 'signedOut', email: null })
    const user = userEvent.setup()
    renderAt(SHARE_ID)

    await user.type(screen.getByLabelText('Work email'), 'sam@example.com')
    await user.click(screen.getByRole('button', { name: 'Email me a sign-in link' }))

    expect(auth.requestCode).toHaveBeenCalledWith('sam@example.com', { board: undefined, returnTo: `/review/${SHARE_ID}` })
  })

  it("shows a signed-in reviewer the newest version and their own threads, and posts a comment", async () => {
    fakeAuth()
    useBoardSessionStore.setState({ status: 'signedIn', email: 'sam@example.com' })
    const user = userEvent.setup()
    renderAt(SHARE_ID)

    expect(await screen.findByRole('heading', { name: 'Faster refunds' })).toBeInTheDocument()
    expect(await screen.findByText('Which refund method?')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Comment on the whole document' }))
    await user.type(screen.getByLabelText('Add a comment'), 'Say how long a bank transfer takes')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => expect(boardFetch).toHaveBeenCalledWith(`/review/${SHARE_ID}/comments`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Say how long a bank transfer takes' }) })))
  })

  it('gives a reviewer no resolve or delete', async () => {
    fakeAuth()
    useBoardSessionStore.setState({ status: 'signedIn', email: 'sam@example.com' })
    renderAt(SHARE_ID)

    await screen.findByText('Which refund method?')
    expect(screen.queryByRole('button', { name: 'Resolve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument()
  })

  it('says one "not available" for a revoked, expired or not-for-you link', async () => {
    boardFetch.mockRejectedValue(new ApiError(404, 'Review link not found'))
    fakeAuth()
    useBoardSessionStore.setState({ status: 'signedIn', email: 'pat@elsewhere.example' })
    renderAt(SHARE_ID)

    expect(await screen.findByRole('heading', { name: 'This link is not available' })).toBeInTheDocument()
  })
})
