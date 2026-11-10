/**
 * @fileoverview File sizes read in the app language: bytes grouped, KB / MB with
 * one decimal and the locale's decimal mark, and a large file in MB rather than
 * thousands of KB.
 */
import { describe, expect, it } from 'vitest'
import { formatFileSize } from './file'

describe('formatFileSize', () => {
  it.each([
    [512, '512 B'],
    [2048, '2.0 KB'],
    [2 * 1024 * 1024, '2.0 MB'],
    [1536 * 1024, '1.5 MB'],
  ])('writes %i bytes as %s in English', (bytes, expected) => {
    expect(formatFileSize(bytes, 'en')).toBe(expected)
  })

  it('uses the decimal comma in Polish', () => {
    expect(formatFileSize(1536 * 1024, 'pl')).toBe('1,5 MB')
    expect(formatFileSize(1536, 'pl')).toBe('1,5 KB')
  })
})
