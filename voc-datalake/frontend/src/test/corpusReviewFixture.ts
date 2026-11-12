/**
 * @fileoverview The review `GET /feedback/{id}` returns in the corpus tests (the corpus modal and the document page's
 * evidence cards): a negative delivery review whose text names its id.
 */
export function corpusReview(id: string, extra: Readonly<Record<string, unknown>> = {}) {
  return {
    feedback_id: id, source_platform: 'webscraper', original_text: `Review text ${id}`, sentiment_label: 'negative',
    sentiment_score: -0.5, category: 'delivery', urgency: 'low', source_created_at: '2026-01-01T10:00:00Z',
    processed_at: '2026-01-01T10:05:00Z', ...extra,
  }
}
