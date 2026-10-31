/**
 * The app's passkey actions bound to its own pool and session: what each hands the passkey client,
 * and that a sign-in's tokens are adopted like a password sign-in's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const client = { signIn: vi.fn(), register: vi.fn(), hasPasskey: vi.fn() }
const mockCreateClient = vi.fn<(deps: unknown) => typeof client>(() => client)
const mockSupported = vi.fn(() => true)
vi.mock('./passkey', () => ({
  createPasskeyClient: (deps: unknown) => mockCreateClient(deps),
  passkeySupported: () => mockSupported(),
}))

const mockAdoptTokens = vi.fn<(tokens: unknown) => void>()
vi.mock('./auth', () => ({ authService: { adoptTokens: (tokens: unknown) => { mockAdoptTokens(tokens) } } }))

const mockAvailable = vi.fn(() => true)
vi.mock('../runtimeConfig', () => ({
  getRuntimeConfig: () => ({ cognito: { region: 'us-east-1', clientId: 'webclient', userPoolId: 'p', identityPoolId: 'i' } }),
  isPasskeyAvailable: () => mockAvailable(),
}))

const authState: { accessToken: string | null } = { accessToken: 'access-token' }
vi.mock('../store/authStore', () => ({ useAuthStore: { getState: () => authState } }))

import { canUsePasskeys, passkeyAuth } from './passkeyAuth'

const TOKENS = { IdToken: 'id', AccessToken: 'access', RefreshToken: 'refresh' }

beforeEach(() => {
  authState.accessToken = 'access-token'
  mockAvailable.mockReturnValue(true)
  mockSupported.mockReturnValue(true)
})

describe('canUsePasskeys', () => {
  it.each([
    [true, true, true],
    [false, true, false],
    [true, false, false],
  ])('is %s && %s = %s (the deployment takes passkeys and the browser can make them)', (available, supported, expected) => {
    mockAvailable.mockReturnValue(available)
    mockSupported.mockReturnValue(supported)
    expect(canUsePasskeys()).toBe(expected)
  })
})

describe('passkeyAuth', () => {
  it('signs in with the trimmed username on the app pool client and adopts the tokens', async () => {
    client.signIn.mockResolvedValueOnce(TOKENS)
    await passkeyAuth.signIn('  dana@example.com ')
    expect(mockCreateClient).toHaveBeenLastCalledWith({ region: 'us-east-1', clientId: 'webclient' })
    expect(client.signIn).toHaveBeenCalledExactlyOnceWith('dana@example.com')
    expect(mockAdoptTokens).toHaveBeenCalledExactlyOnceWith(TOKENS)
  })

  it('registers and checks passkeys with the signed-in access token', async () => {
    client.register.mockResolvedValueOnce(undefined)
    client.hasPasskey.mockResolvedValueOnce(true)
    await passkeyAuth.register()
    await expect(passkeyAuth.hasPasskey()).resolves.toBe(true)
    expect([client.register.mock.calls, client.hasPasskey.mock.calls]).toStrictEqual([[['access-token']], [['access-token']]])
  })

  it.each([null, ''])('refuses without an access token (%j), calling nothing', (token) => {
    authState.accessToken = token
    client.register.mockClear()
    expect(() => passkeyAuth.register()).toThrow('Not signed in')
    expect(client.register).not.toHaveBeenCalled()
  })
})
