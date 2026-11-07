// Dev-mock route for the Data Explorer's Fields panel, in the wire shape of
// lambda/api/metrics_handler.py `GET /feedback/catalogue` (lambda/shared/feedback_catalogue.py,
// docs/data-catalogue.md):
//
//   GET /feedback/catalogue   {version, table, steps: [{name, meaning}], policy_effects: [{name, meaning}],
//                              fields: [{name, type, meaning, set_by, always_present, key, pii, under_redact,
//                                        under_summary_only, values?, builtin_dimensions?, sub_fields?}]}
//
// A representative subset of the real catalogue (keys, customer text, a personal field, enums, the built-in
// dimensions, sub-fields), static like the deployed one: it changes only with a deployment. One row is
// deliberately malformed (no name) so the lenient schema's row drop stays exercised.

const STEPS = [
  { name: 'producer', meaning: 'Copied from the queue message the source sent, after the source policy' },
  { name: 'processor', meaning: 'Computed by the feedback processor when it stores the item' },
  { name: 'enrichment', meaning: 'Comprehend language and sentiment, Translate, and the enrichment model' },
  { name: 'classification', meaning: 'Dimension and tag resolution' },
  { name: 'reprocess', meaning: 'A category reprocess job' },
  { name: 'edit', meaning: 'A person: PUT /feedback/{id}/category|dimensions, PUT /data-explorer/feedback' },
];

const EFFECTS = [
  { name: 'kept', meaning: 'stored as the producer sent it' },
  { name: 'redacted', meaning: 'personal data replaced by placeholders before anything is archived or queued' },
  { name: 'dropped', meaning: 'not stored' },
  { name: 'from_redacted', meaning: 'derived from the redacted text' },
  { name: 'replaced', meaning: 'replaced by a summary' },
];

const field = (name, type, meaning, setBy, extra = {}) => ({
  name, type, meaning, set_by: setBy, always_present: false, key: false, pii: 'none',
  under_redact: 'kept', under_summary_only: 'kept', ...extra,
});

const FIELDS = [
  field('pk', 'string', '`SOURCE#{brand_name}`: the partition of the source the item came from', ['processor'],
    { always_present: true, key: true }),
  field('feedback_id', 'string', 'The item\'s id, stable across reprocessing', ['processor'], { always_present: true }),
  field('original_text', 'string', 'The feedback text as the customer wrote it', ['producer'],
    { always_present: true, pii: 'customer_text', under_redact: 'redacted', under_summary_only: 'replaced' }),
  field('author', 'string', 'The author name the source gave', ['producer'],
    { pii: 'personal', under_redact: 'redacted', under_summary_only: 'dropped' }),
  field('problem_summary', 'string', 'One sentence naming the problem', ['enrichment', 'reprocess'],
    { pii: 'derived_text', under_redact: 'from_redacted', under_summary_only: 'from_redacted' }),
  field('sentiment_label', 'string', 'The sentiment of the text', ['enrichment', 'reprocess'],
    { always_present: true, values: ['mixed', 'negative', 'neutral', 'positive'] }),
  field('urgency', 'string', 'How soon someone should look at it', ['enrichment', 'reprocess'],
    { values: ['high', 'low', 'medium'] }),
  field('usefulness', 'string', 'The heuristic usefulness band', ['processor', 'reprocess'],
    { values: ['low', 'medium', 'high'] }),
  field('category', 'string', 'The category from the taxonomy', ['enrichment', 'reprocess', 'edit']),
  field('dimensions', 'map', 'Dimension key to value', ['classification', 'edit'],
    { builtin_dimensions: { feedback_type: ['bug', 'feature_request', 'praise', 'question', 'other'] } }),
  field('issue_attributes', 'map', 'An issue tracker\'s attributes', ['producer'],
    { sub_fields: [{ name: 'kind', type: 'str' }, { name: 'repo', type: 'str' }, { name: 'number', type: 'int' }] }),
  field('pii_policy', 'string', 'The source policy the item was stored under', ['processor'],
    { values: ['allow', 'redact', 'summary_only'] }),
  { type: 'string', meaning: 'A malformed row the SPA drops' },
];

export function handleFeedbackCatalogueRoutes(req, res, url, send) {
  if (url.pathname !== '/feedback/catalogue') return false;
  if (req.method !== 'GET') send(405, { success: false, error: 'Method not allowed' });
  else send(200, { version: 1, table: 'voc-feedback', steps: STEPS, policy_effects: EFFECTS, fields: FIELDS });
  return true;
}
