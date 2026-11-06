/**
 * The shared copy of a refused resume (`resumeErrorKey`): every card that resumes a reprocess job says why
 * a resume was refused instead of "already running".
 */
import { describe, expect, it } from 'vitest'
import { isResume, resumeErrorKey } from './reprocessCopy'

describe('resumeErrorKey', () => {
  it.each([
    [404, 'categoriesManager.reprocess.resumeGone'],
    [409, 'categoriesManager.reprocess.resumeRefused'],
  ])('names why a resume was refused (%i)', (status, key) => {
    expect(resumeErrorKey(status, { resume: 'rp_0123456789ab' })).toBe(key)
  })

  it.each([500, null, undefined])('leaves any other failure of a resume to the card (%s)', (status) => {
    expect(resumeErrorKey(status, { resume: 'rp_0123456789ab' })).toBeNull()
  })

  it('leaves a refused new job to the card', () => {
    expect(resumeErrorKey(409, { mode: 'processed', days: 0 })).toBeNull()
  })
})

describe('isResume', () => {
  it.each([[{ resume: 'rp_1' }, true], [{ mode: 'raw' }, false], [null, false], [undefined, false], ['x', false]])(
    'reads %j as a resume: %s', (request, expected) => {
      expect(isResume(request)).toBe(expected)
    })
})
