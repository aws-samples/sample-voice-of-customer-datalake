import { describe, expect, it } from 'vitest'
import { normalizeFeedbackPreview } from './feedbackPreviewSchema'

const UNKNOWN = { matched: null, matched_is_lower_bound: false, sample_limit: null, estimated: false, feature_requests_matched: null }

describe('normalizeFeedbackPreview', () => {
  it('keeps a well-formed answer as it is', () => {
    const answer = { matched: 1234, matched_is_lower_bound: true, sample_limit: 500, estimated: true }
    expect(normalizeFeedbackPreview(answer)).toStrictEqual({ ...answer, feature_requests_matched: null })
  })

  it('reads the board requests matched when the answer carries them', () => {
    const answer = { matched: 12, matched_is_lower_bound: false, sample_limit: null, estimated: false, feature_requests_matched: 4 }
    expect(normalizeFeedbackPreview(answer)).toStrictEqual(answer)
  })

  it('degrades a malformed field to unknown and keeps the rest', () => {
    expect(normalizeFeedbackPreview({
      matched: -3, matched_is_lower_bound: 'yes', sample_limit: 1.5, estimated: true, feature_requests_matched: 'four',
    })).toStrictEqual({ ...UNKNOWN, estimated: true })
  })

  it('answers unknown for a body that is not an object', () => {
    expect(normalizeFeedbackPreview(null)).toStrictEqual(UNKNOWN)
    expect(normalizeFeedbackPreview('500 Internal Server Error')).toStrictEqual(UNKNOWN)
  })
})
