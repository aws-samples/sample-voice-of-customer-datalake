/**
 * The passkey actions against a mocked Amplify: registration and the "has a passkey" read call Amplify
 * once it is configured, and every failure becomes a PasskeyError the UI can name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const amplify = vi.hoisted(() => ({ associateWebAuthnCredential: vi.fn(), listWebAuthnCredentials: vi.fn() }))
vi.mock('aws-amplify/auth', () => amplify)

const configureAmplify = vi.hoisted(() => vi.fn())
vi.mock('../lib/amplify-config', () => ({ configureAmplify }))

const signInWithPasskey = vi.hoisted(() => vi.fn<(username: string) => Promise<void>>())
vi.mock('./auth', () => ({ authService: { signInWithPasskey } }))

const available = vi.hoisted(() => ({ value: true }))
vi.mock('../runtimeConfig', () => ({ isPasskeyAvailable: () => available.value }))

import { canUsePasskeys, passkeyAuth } from './passkeyAuth'
import { PasskeyError } from './passkey'

beforeEach(() => {
  vi.clearAllMocks()
  available.value = true
  vi.stubGlobal('PublicKeyCredential', class {})
  vi.stubGlobal('navigator', { credentials: {} })
})

describe('canUsePasskeys', () => {
  it('needs both the deployment and a WebAuthn browser', () => {
    expect(canUsePasskeys()).toBe(true)
    available.value = false
    expect(canUsePasskeys()).toBe(false)
    available.value = true
    vi.stubGlobal('PublicKeyCredential', undefined)
    expect(canUsePasskeys()).toBe(false)
  })
})

describe('passkeyAuth', () => {
  it('signs in through the auth service', async () => {
    signInWithPasskey.mockResolvedValueOnce(undefined)
    await passkeyAuth.signIn('dana@example.com')
    expect(signInWithPasskey).toHaveBeenCalledExactlyOnceWith('dana@example.com')
  })

  it('registers with Amplify once it is configured', async () => {
    amplify.associateWebAuthnCredential.mockImplementationOnce(() => {
      expect(configureAmplify).toHaveBeenCalledWith()
      return Promise.resolve()
    })
    await passkeyAuth.register()
    expect(amplify.associateWebAuthnCredential).toHaveBeenCalledExactlyOnceWith()
  })

  it.each([
    [[{ credentialId: 'c1' }], true],
    [[], false],
  ])('reads one credential to tell whether the person has a passkey (%j -> %s)', async (credentials, expected) => {
    amplify.listWebAuthnCredentials.mockResolvedValueOnce({ credentials })
    await expect(passkeyAuth.hasPasskey()).resolves.toBe(expected)
    expect(amplify.listWebAuthnCredentials).toHaveBeenCalledExactlyOnceWith({ pageSize: 1 })
  })

  it('turns a cancelled registration into a cancelled PasskeyError', async () => {
    amplify.associateWebAuthnCredential.mockRejectedValueOnce(Object.assign(new Error('x'), { name: 'PasskeyRegistrationCanceled' }))
    const error: unknown = await passkeyAuth.register().catch((caught: unknown) => caught)
    expect(error instanceof PasskeyError && error.code).toBe('cancelled')
  })
})
