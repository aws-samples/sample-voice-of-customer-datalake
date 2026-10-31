/**
 * The Login page's passkey button: offered only when passkeys can be used, it needs the username first,
 * signs in with it, and names each failure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { TestRouter } from '../../test/TestRouter'
import { PasskeyError } from '../../services/passkey'

const mockCanUse = vi.fn<() => boolean>()
const mockPasskeySignIn = vi.fn<(username: string) => Promise<void>>()
vi.mock('../../services/passkeyAuth', () => ({
  canUsePasskeys: () => mockCanUse(),
  passkeyAuth: { signIn: (username: string) => mockPasskeySignIn(username) },
}))

const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => ({
  ...await vi.importActual('react-router-dom'),
  useNavigate: () => mockNavigate,
  useLocation: () => ({ state: { from: '/dashboard' }, search: '' }),
}))

import Login from './Login'

const PASSKEY_BUTTON = { name: 'Sign in with a passkey' }

function renderLogin() {
  return renderWithQueryClient(<TestRouter initialEntries={['/login']}><Login /></TestRouter>)
}

beforeEach(() => {
  mockCanUse.mockReturnValue(true)
  mockPasskeySignIn.mockResolvedValue(undefined)
})

describe('Login with a passkey', () => {
  it('offers no passkey button when the deployment or the browser has none', () => {
    mockCanUse.mockReturnValue(false)
    renderLogin()
    expect(screen.queryByRole('button', PASSKEY_BUTTON)).toBeNull()
  })

  it('asks for the username before asking the browser', async () => {
    const user = userEvent.setup()
    renderLogin()
    await user.click(screen.getByRole('button', PASSKEY_BUTTON))
    expect(screen.getByRole('alert')).toHaveTextContent(/Enter your username or email first/)
    expect(mockPasskeySignIn).not.toHaveBeenCalled()
  })

  it('signs in with the typed username and continues where the person was going', async () => {
    const user = userEvent.setup()
    renderLogin()
    await user.type(screen.getByPlaceholderText(/Enter your username/i), 'dana@example.com')
    await user.click(screen.getByRole('button', PASSKEY_BUTTON))
    expect(mockPasskeySignIn).toHaveBeenCalledExactlyOnceWith('dana@example.com')
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard', { replace: true })
  })

  it.each([
    ['no_passkey', /No passkey is set up for this account/],
    ['cancelled', /cancelled or timed out/],
  ] as const)('explains a %s failure and stays on the page', async (code, text) => {
    mockPasskeySignIn.mockRejectedValue(new PasskeyError(code))
    mockNavigate.mockClear()
    const user = userEvent.setup()
    renderLogin()
    await user.type(screen.getByPlaceholderText(/Enter your username/i), 'dana@example.com')
    await user.click(screen.getByRole('button', PASSKEY_BUTTON))
    expect(await screen.findByRole('alert')).toHaveTextContent(text)
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
