/**
 * @fileoverview useUploadError: the message for a design-system upload the limits refuse (type, size), or null.
 */
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { imageFile as file } from '../ProjectDetail/imaging-fixtures'
import { megabytes, useUploadError } from './useUploadError'

describe('useUploadError', () => {
  const rejectionFor = () => renderHook(() => useUploadError()).result.current

  it('names a file of a type the upload does not take', () => {
    expect(rejectionFor()('html', file('page.txt', 'text/plain', 10))).toBe('page.txt is not an accepted file type.')
  })

  it('names a file over the cap with the cap in MB', () => {
    expect(rejectionFor()('screenshot', file('shot.png', 'image/png', 6 * 1024 * 1024))).toBe('shot.png is larger than 5 MB.')
  })

  it('answers null for a file within the limits', () => {
    expect(rejectionFor()('screenshot', file('shot.png', 'image/png', 1024))).toBeNull()
  })
})

describe('megabytes', () => {
  // Review (PR #556): the decimal 1,000,000-byte logo cap read as "0.95367431640625 MB".
  it.each([[5 * 1024 * 1024, 5], [2 * 1024 * 1024, 2], [1_000_000, 1], [2_500_000, 2.5]])('%i bytes → %s MB', (bytes, mb) => {
    expect(megabytes(bytes)).toBe(mb)
  })
})
