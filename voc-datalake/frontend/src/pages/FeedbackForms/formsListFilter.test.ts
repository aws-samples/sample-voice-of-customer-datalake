/**
 * @fileoverview The forms list toolbar's sorts: Last response puts the latest response first and a form without a
 * response time last; Responses by count; Name in the reader's collation.
 */
import { describe, expect, it } from 'vitest'
import type { FeedbackForm } from '../../api/types'
import { normalizeFeedbackForms } from './formSchema'
import type { FormStats } from '../../api/feedbackFormStatsSchema'
import { ALL_FORMS, visibleForms } from './formsListFilter'

const FORMS: readonly FeedbackForm[] = normalizeFeedbackForms([
  { form_id: 'a', name: 'Beta', enabled: true }, { form_id: 'b', name: 'alpha', enabled: true }, { form_id: 'c', name: 'Gamma', enabled: true },
])
const stat = (total: number, last?: string): FormStats => ({
  total_submissions: total, avg_rating: null, rating_count: 0, headline: null,
  ...(last === undefined ? {} : { last_response_at: last }),
})
const STATS: Record<string, FormStats> = {
  a: stat(2, '2026-11-18T09:00:00+00:00'),
  b: stat(9),
  c: stat(5, '2026-11-19T08:30:00+00:00'),
}
const ids = (forms: readonly FeedbackForm[]) => forms.map((f) => f.form_id)

describe('visibleForms', () => {
  it('sorts by the last response, a form without one last', () => {
    expect(ids(visibleForms(FORMS, { ...ALL_FORMS, sort: 'lastResponse' }, STATS, 'en'))).toStrictEqual(['c', 'a', 'b'])
  })

  it('sorts by responses and by name, and keeps the list order for Newest', () => {
    expect(ids(visibleForms(FORMS, { ...ALL_FORMS, sort: 'responses' }, STATS, 'en'))).toStrictEqual(['b', 'c', 'a'])
    expect(ids(visibleForms(FORMS, { ...ALL_FORMS, sort: 'name' }, STATS, 'en'))).toStrictEqual(['b', 'a', 'c'])
    expect(ids(visibleForms(FORMS, ALL_FORMS, STATS, 'en'))).toStrictEqual(['a', 'b', 'c'])
  })
})
