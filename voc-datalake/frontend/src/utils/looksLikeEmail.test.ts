import { describe, expect, it } from 'vitest'
import { looksLikeEmail } from './looksLikeEmail'

describe('looksLikeEmail', () => {
  it.each(['ana@example.com', 'a.b+tag@mail.example.co'])('accepts %s', (email) => {
    expect(looksLikeEmail(email)).toBe(true)
  })

  it.each([
    ['an empty string', ''],
    ['no @', 'ana.example.com'],
    ['two @', 'ana@b@example.com'],
    ['an empty local part', '@example.com'],
    ['an undotted domain', 'ana@localhost'],
    ['an empty domain label', 'ana@example..com'],
    ['a trailing dot', 'ana@example.com.'],
    ['a space', 'ana @example.com'],
  ])('rejects %s', (_label, email) => {
    expect(looksLikeEmail(email)).toBe(false)
  })
})
