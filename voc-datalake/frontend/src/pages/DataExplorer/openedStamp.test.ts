/**
 * The Data Explorer save body: the edited fields plus the `updated_at` the record was opened with ('' when
 * never stamped), which the API compares with the stored stamp (409 on a stale editor).
 */
import { describe, expect, it } from 'vitest'
import { openedStamp, savedFeedbackBody } from './openedStamp'

describe('openedStamp', () => {
  it('is the stamp the record was opened with', () => {
    expect(openedStamp({ feedback_id: 'f1', updated_at: '2026-11-01T00:00:00+00:00' })).toBe('2026-11-01T00:00:00+00:00')
  })

  it.each([[{ feedback_id: 'f1' }], [{ updated_at: null }], [null], ['text'], [undefined]])(
    'is empty for a record never stamped (%j), so the API still guards it', (opened) => {
      expect(openedStamp(opened)).toBe('')
    })
})

describe('savedFeedbackBody', () => {
  it('sends the stamp the record was opened with, even when the JSON was edited', () => {
    expect(savedFeedbackBody({ urgency: 'low', updated_at: 'typed by hand' }, { updated_at: 'opened-stamp' }))
      .toStrictEqual({ urgency: 'low', updated_at: 'opened-stamp' })
  })

  it('sends an empty stamp for a record opened unstamped', () => {
    expect(savedFeedbackBody({ urgency: 'low' }, { feedback_id: 'f1' })).toStrictEqual({ urgency: 'low', updated_at: '' })
  })

  it('saves no fields when the editor content is not an object', () => {
    expect(savedFeedbackBody('text', {})).toStrictEqual({ updated_at: '' })
  })
})
