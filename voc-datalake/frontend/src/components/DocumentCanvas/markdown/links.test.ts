import { describe, expect, it } from 'vitest'
import { isSafeHref, normalizeHref } from './links'

describe('isSafeHref', () => {
  it.each([
    ['https://example.com/x'],
    ['http://example.com'],
    ['mailto:someone@example.com'],
    ['/feature-requests?request=fr_1'],
    ['#h-goals'],
    ['?tab=documents'],
    ['docs/page'],
    ['/path?next=https://example.com'],
  ])('accepts %s', (url) => {
    expect(isSafeHref(url)).toBe(true)
  })

  it.each([
    ['javascript:alert(1)'],
    ['java\tscript:alert(1)'],
    ['data:text/html,x'],
    ['//other.example/x'],
    ['/\t/other.example/x'],
    ['\\\\host/share'],
    ['\\other.example'],
    ['/\\other.example/x'],
    ['docs\\..\\x'],
    ['docs//other.example'],
    [''],
  ])('refuses %s', (url) => {
    expect(isSafeHref(url)).toBe(false)
  })
})

describe('normalizeHref', () => {
  it('adds mailto: and https:, keeps paths', () => {
    expect(normalizeHref('name@example.com')).toBe('mailto:name@example.com')
    expect(normalizeHref('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeHref('/projects/p1')).toBe('/projects/p1')
  })

  it('refuses a protocol-relative or backslash address', () => {
    expect(normalizeHref('//evil.example/x')).toBeNull()
    expect(normalizeHref('\\\\evil.example')).toBeNull()
    expect(normalizeHref('/\\evil.example')).toBeNull()
  })
})
