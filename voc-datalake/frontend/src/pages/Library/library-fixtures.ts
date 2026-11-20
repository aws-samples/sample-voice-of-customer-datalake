/**
 * @fileoverview Fictional library items for the Library page's specs (the wire's shape, lambda/shared/library_store.py
 * PUBLIC_FIELDS).
 */
export const Q3_ID = 'lib_20261101090000_a1b2c3d4'
export const SURVEY_ID = 'lib_20261105103000_b2c3d4e5'
export const FAQ_ID = 'lib_20261110141500_c3d4e5f6'

const ALEX = { sub: 'sub-alex', name: 'Alex Rivera' }

export function libraryItem(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_id: Q3_ID, title: 'Q3 market report (Example Ltd)', slug: 'q3-market', source: 'Example Ltd research team',
    doc_date: '2026-10-01', tags: ['market', 'q3'], filename: 'q3-market-report.pdf', content_type: 'application/pdf',
    format: 'pdf', bytes: 1_887_437, status: 'ready', extracted_chars: 4200, pages: 3, chunks: 3, native: true,
    created_by: ALEX, created_at: '2026-11-01T12:00:00Z', updated_by: ALEX, updated_at: '2026-11-02T12:00:00Z', version: 2,
    ...extra,
  }
}

export const surveyItem = (extra: Record<string, unknown> = {}) => libraryItem({
  item_id: SURVEY_ID, title: 'Onboarding survey results', slug: 'onboarding-survey', source: '', doc_date: '', tags: ['survey'],
  filename: 'onboarding-survey.csv', content_type: 'text/csv', format: 'csv', bytes: 48_200, pages: undefined,
  created_by: { sub: 'sub-sam', name: '' }, created_at: '2026-11-05T12:00:00Z', ...extra,
})

export const faqItem = (extra: Record<string, unknown> = {}) => libraryItem({
  item_id: FAQ_ID, title: 'Pricing FAQ', slug: 'pricing-faq', filename: 'pricing-faq.md', content_type: 'text/markdown',
  format: 'md', bytes: 6_300, pages: undefined, native: false, ...extra,
})

export const libraryPage = (items: readonly Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  items, total: items.length, tags: ['market', 'q3', 'survey'], next_cursor: null, ...extra,
})

export const detailOf = (item: Record<string, unknown>, parts = 3) => ({
  item, preview: { text_excerpt: 'Summary', text_parts: parts, original_url: 'https://s3.example.com/original?sig=1' },
})
