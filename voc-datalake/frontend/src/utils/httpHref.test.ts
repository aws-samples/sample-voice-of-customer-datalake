import { describe, expect, it } from 'vitest'
import { httpHref } from './httpHref'

describe('httpHref', () => {
  it.each([
    ['https://reviews.example.com/r/1', 'https://reviews.example.com/r/1'],
    ['  http://example.com  ', 'http://example.com/'],
  ])('keeps an absolute web URL (%s)', (value, expected) => {
    expect(httpHref(value)).toBe(expected)
  })

  it.each([
    'javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '/feedback/1', '//evil.example', 'not a url', '', null, undefined,
  ])('refuses %s', (value) => {
    expect(httpHref(value)).toBeUndefined()
  })
})
