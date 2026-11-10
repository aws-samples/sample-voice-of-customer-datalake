import { afterEach, describe, expect, it, vi } from 'vitest'
import { PasskeyError, passkeySupported, toPasskeyError } from './passkey'

afterEach(() => { vi.unstubAllGlobals() })

describe('passkeySupported', () => {
  it('needs PublicKeyCredential and a credentials container (jsdom has neither)', () => {
    expect(passkeySupported()).toBe(false)
    vi.stubGlobal('PublicKeyCredential', class {})
    vi.stubGlobal('navigator', { credentials: {} })
    expect(passkeySupported()).toBe(true)
  })
})

describe('toPasskeyError', () => {
  it.each([
    ['PasskeyRegistrationCanceled', 'cancelled'],
    ['PasskeyAuthenticationCanceled', 'cancelled'],
    ['PasskeyOperationAborted', 'cancelled'],
    ['NotAllowedError', 'cancelled'],
    ['PasskeyNotSupported', 'unsupported'],
    ['StartWebAuthnRegistrationException', 'unknown'],
  ])('reads %s as %s', (name, code) => {
    expect(toPasskeyError(Object.assign(new Error('x'), { name })).code).toBe(code)
  })

  it('keeps a PasskeyError and reads a non-error as unknown', () => {
    const own = new PasskeyError('no_passkey')
    expect([toPasskeyError(own), toPasskeyError('boom').code]).toStrictEqual([own, 'unknown'])
  })
})
