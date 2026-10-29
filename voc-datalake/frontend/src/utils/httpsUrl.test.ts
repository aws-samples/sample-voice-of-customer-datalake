import { describe, expect, it } from 'vitest'
import { isHttpsUrl } from './httpsUrl'

describe('isHttpsUrl', () => {
  it.each([
    ['https://example.com/survey', true],
    ['http://example.com', false],
    ['javascript:alert(1)', false],
    ['not a url', false],
    ['https://example.com/a b', false],
    ['', false],
  ])('%s → %s', (value, expected) => {
    expect(isHttpsUrl(value)).toBe(expected)
  })
})
