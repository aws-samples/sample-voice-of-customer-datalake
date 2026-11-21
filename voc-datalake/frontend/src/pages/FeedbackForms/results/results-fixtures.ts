/**
 * Shared test support for the Results specs: a form with one question of each measured kind, and its results.
 */
import type { FormV2 } from '../model/formsV2'
import { blankForm } from '../test/blankForm'

export const RESULTS_FORM: FormV2 = {
  ...blankForm('en'),
  name: 'Old interface',
  questions: [
    {
      id: 'q_why', type: 'multi_select', headline: { en: 'What made you switch back?' }, required: true,
      options: [{ code: 'cant_find', label: { en: "I can't find what I need" } }, { code: 'slower_work', label: { en: 'My work takes longer' } }],
      other: { enabled: true, label: { en: 'Something else' } }, none: { enabled: false }, shuffle: 'none', display: 'list', max: 3,
    },
    { id: 'q_nps', type: 'nps', headline: { en: 'How likely are you to recommend us?' }, required: true },
    { id: 'q_rating', type: 'rating', headline: { en: 'How satisfied are you with this feature?' }, required: true, scale: 'star', range: 5 },
    { id: 'q_csat', type: 'csat', headline: { en: 'How satisfied are you with the help?' }, required: true },
    { id: 'q_ces', type: 'ces', headline: { en: 'How easy was it?' }, required: true },
    { id: 'q_comment', type: 'open_text', headline: { en: 'Anything else?' }, required: false, long: true, input_type: 'text' },
  ],
  endings: [{ id: 'end_thanks', title: { en: 'Thank you' } }],
  hidden_fields: [{ id: 'user_id' }],
}

const reach = (answered: number) => ({ answered, skipped: 0, not_shown: 0 })

export const RESULTS = {
  total: 10,
  test_count: 0,
  last_response_at: '2026-11-17T12:00:00Z',
  questions: {
    q_why: { ...reach(10), counts: { cant_find: 4, slower_work: 3, other: 2 }, other_answers: ['printing', 'the menu'] },
    q_nps: { ...reach(10), distribution: { 0: 2, 5: 1, 7: 2, 9: 3, 10: 2 } },
    q_rating: { ...reach(5), distribution: { 3: 1, 4: 2, 5: 2 } },
    q_csat: { ...reach(5), distribution: { 2: 1, 4: 1, 5: 3 } },
    q_ces: { ...reach(4), distribution: { 3: 2, 5: 1, 7: 1 } },
    q_comment: { answered: 2, skipped: 6, not_shown: 2, latest: [
      { text: 'The export is gone', sentiment: 'negative', feedback_id: 'fb_1', submitted_at: '2026-11-17T11:00:00Z' },
      { text: 'Fine otherwise', sentiment: null },
    ] },
  },
  endings: { end_thanks: 10 },
  removed_questions: [],
  removed_options: {},
  funnel: null,
}
