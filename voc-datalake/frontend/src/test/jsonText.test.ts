import { describe, expect, it } from 'vitest'
import { asText, parsedJson } from './jsonText'

describe('asText', () => {
  it('returns a string unchanged', () => {
    expect(asText('{"a":1}')).toBe('{"a":1}')
  })

  it('names the type that arrived instead of a string', () => {
    expect(() => asText({ a: 1 })).toThrow('expected a string, got object')
    expect(() => asText(null)).toThrow('expected a string, got null')
    expect(() => asText(undefined)).toThrow('expected a string, got undefined')
  })
})

describe('parsedJson', () => {
  it('parses the JSON a string holds', () => {
    expect(parsedJson('{"list_ids":["lst_1"]}')).toStrictEqual({ list_ids: ['lst_1'] })
  })

  it('refuses a body that is not text', () => {
    expect(() => parsedJson(new Blob(['{}']))).toThrow('expected a string, got object')
  })
})
