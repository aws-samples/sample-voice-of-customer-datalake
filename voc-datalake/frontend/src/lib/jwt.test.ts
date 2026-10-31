import { describe, it, expect } from 'vitest'
import { fakeJwt } from '@test/fakeJwt'
import { jwtExpiresAt, jwtPayload } from './jwt'

describe('jwtPayload', () => {
  it('decodes the claims of a base64url payload', () => {
    expect(jwtPayload(fakeJwt({ sub: 'abc', 'cognito:groups': ['admins'] }))).toStrictEqual({
      sub: 'abc', 'cognito:groups': ['admins'],
    })
  })

  it('decodes UTF-8 claims (a display name with accents)', () => {
    const payload = btoa(String.fromCodePoint(...new TextEncoder().encode(JSON.stringify({ name: 'José Ñandú' }))))
    expect(jwtPayload(`h.${payload.replaceAll('=', '')}.s`)).toStrictEqual({ name: 'José Ñandú' })
  })

  it.each([
    ['no payload segment', 'only-a-header'],
    ['not base64', 'h.%%%.s'],
    ['not JSON', `h.${btoa('not json')}.s`],
    ['a JSON array', `h.${btoa('[1,2]')}.s`],
  ])('answers {} for %s', (_label, token) => {
    expect(jwtPayload(token)).toStrictEqual({})
  })
})

describe('jwtExpiresAt', () => {
  it('is exp in milliseconds', () => {
    expect(jwtExpiresAt(fakeJwt({ exp: 1_800_000_000 }))).toBe(1_800_000_000_000)
  })

  it('is 0 without a numeric exp', () => {
    expect(jwtExpiresAt(fakeJwt({ exp: 'soon' }))).toBe(0)
    expect(jwtExpiresAt('garbage')).toBe(0)
  })
})
