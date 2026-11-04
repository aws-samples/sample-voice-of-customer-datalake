import { describe, expect, it } from 'vitest'
import { hasContactData, isLegalBasis, MAX_LEGAL_BASIS_CHARS } from './legalBasis'

describe('hasContactData', () => {
  it.each([
    'Request from someone@example.com',
    'Request from (someone@example.com).',
    'call +44 20 7946 0958',
    'phone (020) 7946-0958',
    'tel 020.7946.0958',
    '+441234567890',
  ])('flags %j', (text) => {
    expect(hasContactData(text)).toBe(true)
  })

  it.each([
    'GDPR art. 17 request #123',
    'GDPR art. 17 request #123456789',
    'Erasure request of 2026-11-03',
    'ticket 12345678',
    'see @legal team',
    'a@b',
    '',
  ])('passes %j', (text) => {
    expect(hasContactData(text)).toBe(false)
  })
})

describe('isLegalBasis', () => {
  it('needs a non-blank text within the limit and without contact data', () => {
    expect(isLegalBasis('GDPR art. 17 request #123')).toBe(true)
    expect(isLegalBasis('   ')).toBe(false)
    expect(isLegalBasis('x'.repeat(MAX_LEGAL_BASIS_CHARS + 1))).toBe(false)
    expect(isLegalBasis('Request from someone@example.com')).toBe(false)
  })
})
