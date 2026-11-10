import { describe, expect, it } from 'vitest'
import { passkeyErrorText } from './passkeyErrorText'
import { PasskeyError } from '../../services/passkey'
import type { PasskeyErrorCode } from '../../services/passkey'

// Echoes the key, so the test reads which sentence was chosen.
const t = (key: string) => key

describe('passkeyErrorText', () => {
  it.each<PasskeyErrorCode>(['cancelled', 'no_passkey', 'unsupported', 'unknown'])('names the %s sentence', (code) => {
    expect(passkeyErrorText(t, new PasskeyError(code))).toBe(`login:passkey.errors.${code}`)
  })

  it('reads anything that is not a PasskeyError as unknown', () => {
    expect(passkeyErrorText(t, new Error('boom'))).toBe('login:passkey.errors.unknown')
  })
})
