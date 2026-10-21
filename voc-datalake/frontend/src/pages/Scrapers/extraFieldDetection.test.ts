/**
 * @fileoverview Tests for extraFieldDetection — field sniffing for the Phase 5
 * import mapping screen.
 */
import { describe, it, expect } from 'vitest'
import { extractFieldsFromText, detectFileFields, FIELD_SNIFF_BYTES } from './extraFieldDetection'

describe('extractFieldsFromText', () => {
  it('returns the keys of the first object in a JSON array', () => {
    const text = '[{"text":"hi","platform":"web","rating":5},{"text":"other"}]'
    expect(extractFieldsFromText(text)).toEqual(['text', 'platform', 'rating'])
  })

  it('returns the keys of the first object in an {items:[...]} wrapper', () => {
    const text = '{"items":[{"text":"hi","region":"EMEA"}]}'
    // The wrapper object itself is the first {...}; its key is `items`.
    expect(extractFieldsFromText(text)).toEqual(['items'])
  })

  it('returns the keys of the first JSONL line', () => {
    const text = '{"text":"a","source":"x"}\n{"text":"b","source":"y"}\n'
    expect(extractFieldsFromText(text)).toEqual(['text', 'source'])
  })

  it('is not fooled by braces inside string values', () => {
    const text = '[{"text":"a } { b","platform":"web"}]'
    expect(extractFieldsFromText(text)).toEqual(['text', 'platform'])
  })

  it('handles nested objects without ending the record early', () => {
    const text = '[{"text":"a","meta":{"k":"v"},"platform":"web"}]'
    expect(extractFieldsFromText(text)).toEqual(['text', 'meta', 'platform'])
  })

  it('recovers the first object from a truncated array head', () => {
    // A large array sliced mid-stream: the first object is complete, the rest truncated.
    const text = '[{"text":"a","platform":"web"},{"text":"b","plat'
    expect(extractFieldsFromText(text)).toEqual(['text', 'platform'])
  })

  it('returns [] when no complete object is present', () => {
    expect(extractFieldsFromText('[{"text":"a","plat')).toEqual([])
    expect(extractFieldsFromText('not json at all')).toEqual([])
    expect(extractFieldsFromText('')).toEqual([])
  })

  it('returns [] for a top-level array of non-objects', () => {
    expect(extractFieldsFromText('["a","b","c"]')).toEqual([])
  })
})

/**
 * jsdom's `Blob.slice().text()` is not implemented, so model a File whose
 * `slice(0, n)` returns a blob with a working `.text()` over the head bytes —
 * the behavior a real browser provides.
 */
function makeFileWithSlice(content: string, name = 'data.json'): File {
  const file = new File([content], name, { type: 'application/json' })
  Object.defineProperty(file, 'slice', {
    value: (start = 0, end = content.length) => ({
      text: () => Promise.resolve(content.slice(start, end)),
    }),
  })
  return file
}

describe('detectFileFields', () => {
  it('reads only the head slice and returns detected fields', async () => {
    const result = await detectFileFields(makeFileWithSlice('[{"text":"a","platform":"web"}]'))
    expect(result.fields).toEqual(['text', 'platform'])
  })

  it('returns an empty list for a head with no readable record', async () => {
    const result = await detectFileFields(makeFileWithSlice('garbage not json'))
    expect(result.fields).toEqual([])
  })

  it('exposes a bounded sniff size so huge files are not read whole', () => {
    expect(FIELD_SNIFF_BYTES).toBe(256 * 1024)
  })
})
