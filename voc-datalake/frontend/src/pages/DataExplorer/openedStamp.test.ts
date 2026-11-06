import { describe, expect, it } from 'vitest'
import { openedStamp } from './openedStamp'

describe('openedStamp', () => {
  it('is the stamp the record was opened with', () => {
    expect(openedStamp({ feedback_id: 'f1', updated_at: '2026-11-01T00:00:00+00:00' })).toBe('2026-11-01T00:00:00+00:00')
  })

  it.each([[{ feedback_id: 'f1' }], [{ updated_at: null }], [null], ['text'], [undefined]])(
    'is empty for a record never stamped (%j), so the API still guards it', (opened) => {
      expect(openedStamp(opened)).toBe('')
    })
})
