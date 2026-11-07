// Dev-mock route for the Data Explorer's Fields panel, in the wire shape of
// lambda/api/metrics_handler.py `GET /feedback/catalogue` (lambda/shared/feedback_catalogue.py,
// docs/data-catalogue.md):
//
//   GET /feedback/catalogue   {version, table, steps: [{name, meaning}], policy_effects: [{name, meaning}],
//                              fields: [{name, type, meaning, set_by, always_present, key, pii, under_redact,
//                                        under_summary_only, values?, builtin_dimensions?, sub_fields?}]}
//
// The real catalogue, written by `python -m shared.feedback_catalogue` (with docs/data-catalogue.md) and pinned
// by lambda/shared/test/test_feedback_catalogue.py, so the mock never drifts from what the API answers. One
// malformed row (no name) is appended so the SPA's lenient schema keeps dropping it in dev.
import { readFileSync } from 'node:fs';

const CATALOGUE = JSON.parse(readFileSync(new URL('./mock-feedback-catalogue.json', import.meta.url), 'utf8'));
const MALFORMED_ROW = { type: 'string', meaning: 'A malformed row the SPA drops' };

export function handleFeedbackCatalogueRoutes(req, res, url, send) {
  if (url.pathname !== '/feedback/catalogue') return false;
  if (req.method !== 'GET') send(405, { success: false, error: 'Method not allowed' });
  else send(200, { ...CATALOGUE, fields: [...CATALOGUE.fields, MALFORMED_ROW] });
  return true;
}
