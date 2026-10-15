/**
 * Guards that every reader of a shared feedback-form query key uses the helper.
 *
 * Lives beside the helper rather than in one of the four consumers' test files:
 * someone editing `FormCard.tsx` looks here, not in
 * `pages/Prioritization/LinkedFormEvidence.test.tsx`.
 *
 * Neither key drifts loudly, which is why this is asserted over the source text
 * instead of through behaviour:
 *
 * - `['feedback-forms']` renamed on one side gives that reader its own cache
 *   entry that no mutation invalidates, so it serves a stale list until reload.
 * - `['form-stats', id]` renamed gives the evidence panel its own entry, and it
 *   pays again for a brand-wide partition scan the form card had already cached.
 *
 * Both keep working. Nothing fails. That is the whole problem.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  feedbackFormsKey, formStatsKey, FORM_STATS_STALE_TIME_MS,
} from './feedbackFormQueryKeys'

/** Every consumer, relative to this file, and the symbols it must be using. */
const CONSUMERS: Readonly<Record<string, readonly string[]>> = {
  '../pages/FeedbackForms/FeedbackForms.tsx': ['feedbackFormsKey()'],
  '../pages/FeedbackForms/FormCard.tsx': ['formStatsKey(', 'FORM_STATS_STALE_TIME_MS'],
  '../pages/Prioritization/Prioritization.tsx': ['feedbackFormsKey()'],
  '../pages/Prioritization/LinkedFormEvidence.tsx': ['formStatsKey(', 'FORM_STATS_STALE_TIME_MS'],
}

describe('shared feedback-form query keys', () => {
  it('produces the keys the cache is actually addressed by', () => {
    // Pins the literals themselves: renaming one here would silently move every
    // consumer to a new cache entry at once, which no consumer-side test can see.
    expect(feedbackFormsKey()).toEqual(['feedback-forms'])
    expect(formStatsKey('abc123')).toEqual(['form-stats', 'abc123'])
    expect(FORM_STATS_STALE_TIME_MS).toBe(30000)
  })

  it('is used by every consumer, with no literal left behind', () => {
    for (const [file, symbols] of Object.entries(CONSUMERS)) {
      const source = readFileSync(join(__dirname, file), 'utf-8')

      expect(source, `${file} must import the shared keys`)
        .toContain("api/feedbackFormQueryKeys'")
      for (const symbol of symbols) {
        expect(source, `${file} should use ${symbol}`).toContain(symbol)
      }
      expect(source, `${file} still spells a feedback-form query key literally`)
        .not.toMatch(/queryKey: \['(feedback-forms|form-stats)/)
    }
  })
})
