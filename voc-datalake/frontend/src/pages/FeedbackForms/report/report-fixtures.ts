/**
 * @fileoverview A workshop form and its report (7.63.00), for the Report's specs: two customers, one segment of 7 and
 * the rest merged and withheld, a matrix, themes with real quotes, and an AI summary.
 *
 * @module pages/FeedbackForms/report/report-fixtures
 */
import { parseFormReport } from '../../../api/feedbackFormsReport'
import type { FormReport } from '../../../api/feedbackFormsReport'
import type { FormV2 } from '../model/formsV2'
import { blankForm } from '../test/blankForm'

export const REPORT_FORM: FormV2 = {
  ...blankForm('en'),
  name: 'Example Ltd workshop',
  template: { id: 'workshop', version: 1 },
  hidden_fields: [{ id: 'customer', label: 'Customer' }, { id: 'event_date', label: 'Event date' }],
  questions: [
    { id: 'q_role', type: 'single_select', headline: { en: 'Your role' }, required: true, display: 'list', shuffle: 'none',
      options: [{ code: 'qa', label: { en: 'QA' } }, { code: 'design', label: { en: 'Design' } }], other: { enabled: false }, none: { enabled: false } },
    { id: 'q_nps', type: 'nps', headline: { en: 'Recommend it?' }, required: true },
    { id: 'q_phases', type: 'matrix', headline: { en: 'Each part' }, required: false, shuffle_rows: false, display: 'auto',
      rows: [{ code: 'labs', label: { en: 'Labs' } }], columns: [{ code: 'meh', label: { en: 'Meh' }, score: 1 }, { code: 'great', label: { en: 'Great' }, score: 4 }] },
    { id: 'q_takeaway', type: 'open_text', headline: { en: 'Your takeaway' }, required: false, long: true, input_type: 'text' },
    { id: 'q_contact', type: 'contact_info', headline: { en: 'Contact' }, required: false,
      fields: { name: { show: false, required: false }, email: { show: true, required: false }, phone: { show: false, required: false }, company: { show: false, required: false } } },
  ],
}

export const REPORT: FormReport = parseFormReport({
  name: 'Example Ltd workshop', responses: 9, test_responses: 0, first_response_at: '2026-11-10T10:00:00', last_response_at: '2026-11-18T10:00:00',
  kpis: [{ id: 'q_nps', type: 'nps', answered: 9, skipped: 0, average: 8.1, nps: { score: 33.3, promoters: 4, passives: 4, detractors: 1 } }],
  matrices: [{ id: 'q_phases', answered: 8, scored: true, columns: ['meh', 'great'], rows: [{ code: 'labs', answered: 8, counts: { meh: 2, great: 6 }, average: 3.25 }] }],
  segments: null,
  themes: [{ question_id: 'q_takeaway', answered: 4, themes: [{ category: 'content', subcategory: 'labs', count: 4, sentiment: { positive: 3, negative: 1 },
    quotes: [{ response_id: 'fb_3', text: 'Loved the labs', created_at: '2026-11-18T10:00:00', sentiment: 'positive' }] }] }],
  ai: { report_id: 'rpt_1', created_at: '2026-11-18T12:00:00Z', summary: 'Keep the labs, shorten the intro.', model: 'm', stale: true, responses_counted: 8,
    themes: [{ label: 'Labs are the highlight', count: 3, sentiment: 'positive', quotes: [{ response_id: 'fb_3', text: 'Loved the labs' }] }] },
  min_segment: 5,
})

export const SEGMENTED: FormReport = {
  ...REPORT,
  segments: { by: 'q_role', min_size: 5, groups: [{ value: 'qa', responses: 7, scores: { q_nps: { type: 'nps', answered: 7, nps: 42.9 } } }],
    merged: { segments: 1, responses: 2, scores: null } },
}
