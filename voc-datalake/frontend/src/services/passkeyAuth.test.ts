/**
 * The passkey actions against a mocked Amplify: registration and the "has a passkey" read call Amplify
 * once it is configured, and every failure becomes a PasskeyError the UI can name.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const amplify = vi.hoisted(() => ({ associateWebAuthnCredential: vi.fn(), listWebAuthnCredentials: vi.fn(), deleteWebAuthnCredential: vi.fn() }))
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

  it('lists every page of passkeys, skipping a credential without an id', async () => {
    const created = new Date('2026-10-01T10:00:00Z')
    amplify.listWebAuthnCredentials
      .mockResolvedValueOnce({ credentials: [{ credentialId: 'c1', friendlyCredentialName: 'Phone', createdAt: created }, { credentialId: undefined }], nextToken: 'n1' })
      .mockResolvedValueOnce({ credentials: [{ credentialId: 'c2', friendlyCredentialName: undefined, createdAt: undefined }] })
    await expect(passkeyAuth.list()).resolves.toStrictEqual([
      { id: 'c1', name: 'Phone', createdAt: created },
      { id: 'c2', name: undefined, createdAt: undefined },
    ])
    expect(amplify.listWebAuthnCredentials.mock.calls).toStrictEqual([[{ pageSize: 20, nextToken: undefined }], [{ pageSize: 20, nextToken: 'n1' }]])
  })

  it('removes a passkey by its credential id', async () => {
    amplify.deleteWebAuthnCredential.mockResolvedValueOnce(undefined)
    await passkeyAuth.remove('c1')
    expect(amplify.deleteWebAuthnCredential).toHaveBeenCalledExactlyOnceWith({ credentialId: 'c1' })
  })
})
