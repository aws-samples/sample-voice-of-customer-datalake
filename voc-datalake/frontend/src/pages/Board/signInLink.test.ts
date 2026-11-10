/** The emailed link's `email` / `code` are dropped from a search string; everything else stays. */
import { describe, expect, it } from 'vitest'
import { hasSignInParams, withoutSignInParams } from './signInLink'

describe('withoutSignInParams', () => {
  it('drops the emailed email and code but keeps the shared request', () => {
    expect(withoutSignInParams('?email=dana%40example.com&code=12345678&request=fr_1')).toBe('?request=fr_1')
  })

  it('leaves no question mark when only the sign-in params were present', () => {
    expect(withoutSignInParams('?email=dana%40example.com&code=12345678')).toBe('')
  })

  it('returns an empty search unchanged', () => {
    expect(withoutSignInParams('')).toBe('')
  })

  it('keeps unrelated params in their order', () => {
    expect(withoutSignInParams('?b=2&code=1&a=1')).toBe('?b=2&a=1')
  })
})

describe('hasSignInParams', () => {
  it('detects a leftover email or code', () => {
    expect(hasSignInParams('?code=1')).toBe(true)
    expect(hasSignInParams('?email=a%40b.c')).toBe(true)
    expect(hasSignInParams('?request=fr_1')).toBe(false)
  })
})
