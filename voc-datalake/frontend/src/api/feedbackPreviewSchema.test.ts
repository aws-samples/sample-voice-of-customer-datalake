import { describe, expect, it } from 'vitest'
import { normalizeFeedbackPreview } from './feedbackPreviewSchema'

const UNKNOWN = { matched: null, matched_is_lower_bound: false, sample_limit: null, estimated: false }

describe('normalizeFeedbackPreview', () => {
  it('keeps a well-formed answer as it is', () => {
    const answer = { matched: 1234, matched_is_lower_bound: true, sample_limit: 500, estimated: true }
    expect(normalizeFeedbackPreview(answer)).toStrictEqual(answer)
  })

  it('degrades a malformed field to unknown and keeps the rest', () => {
    expect(normalizeFeedbackPreview({ matched: -3, matched_is_lower_bound: 'yes', sample_limit: 1.5, estimated: true }))
      .toStrictEqual({ ...UNKNOWN, estimated: true })
  })

  it('answers unknown for a body that is not an object', () => {
    expect(normalizeFeedbackPreview(null)).toStrictEqual(UNKNOWN)
    expect(normalizeFeedbackPreview('500 Internal Server Error')).toStrictEqual(UNKNOWN)
  })
})
