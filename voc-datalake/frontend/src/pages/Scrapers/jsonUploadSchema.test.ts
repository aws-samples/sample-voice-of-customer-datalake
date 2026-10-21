import { describe, it, expect } from 'vitest'
import { validateFileBasics, isLargeJsonFile, parseJsonFeedback } from './jsonUploadSchema'
import { SYNC_JSON_UPLOAD_MAX_BYTES } from '../../api/s3Upload'

/** A File whose reported size is `bytes`, without allocating that many bytes. */
function fileOfSize(bytes: number, name = 'data.json'): File {
  const f = new File(['{}'], name, { type: 'application/json' })
  Object.defineProperty(f, 'size', { value: bytes })
  return f
}

describe('validateFileBasics', () => {
  it('accepts a .json file regardless of size (large files route to S3)', () => {
    expect(validateFileBasics(fileOfSize(SYNC_JSON_UPLOAD_MAX_BYTES * 10))).toBeNull()
  })

  it('rejects a non-.json file', () => {
    expect(validateFileBasics(fileOfSize(10, 'data.csv'))).toBe('File must be a .json file')
  })
})

describe('isLargeJsonFile', () => {
  it('is false at or below the sync threshold', () => {
    expect(isLargeJsonFile(fileOfSize(SYNC_JSON_UPLOAD_MAX_BYTES))).toBe(false)
    expect(isLargeJsonFile(fileOfSize(1024))).toBe(false)
  })

  it('is true above the sync threshold', () => {
    expect(isLargeJsonFile(fileOfSize(SYNC_JSON_UPLOAD_MAX_BYTES + 1))).toBe(true)
  })
})

describe('parseJsonFeedback (small-file path)', () => {
  it('parses a valid items array', () => {
    const content = JSON.stringify([
      { id: 'a1', text: 'great', source: 'trustpilot', timestamp: '2026-01-01T00:00:00Z' },
    ])
    const result = parseJsonFeedback(content)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.data).toHaveLength(1)
  })

  it('still enforces the 500-item cap on the synchronous path', () => {
    const items = Array.from({ length: 501 }, (_, i) => ({
      id: `id-${i}`, text: 't', source: 'trustpilot', timestamp: '2026-01-01T00:00:00Z',
    }))
    const result = parseJsonFeedback(JSON.stringify(items))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.errors.join(' ')).toMatch(/500/)
  })

  it('rejects content that is neither an array nor an {items:[]} object', () => {
    const result = parseJsonFeedback(JSON.stringify({ foo: 'bar' }))
    expect(result.ok).toBe(false)
  })
})
