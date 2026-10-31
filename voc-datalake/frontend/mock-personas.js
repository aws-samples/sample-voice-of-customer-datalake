// Dev-mock routes for the persona and research wizards' persona extras (ported from #429 by @aws-bryan),
// in the wire shape of lambda/api/projects_handler.py:
//
//   POST /projects/{id}/feedback-preview  {sources, categories, sentiments, days, mode, purpose}
//        -> {matched, matched_is_lower_bound, estimated, sample_limit}   (projects.preview_feedback)
//
// Counted from the shared fixture feedback like the F1 pre-check in mock-project-actions.js: an empty
// list matches everything and `days` is not applied (the fixture dates are static). The estimate
// answers the same count, so the wizard's "About N … confirming" line settles on the exact one.

import { matchingFeedback } from './mock-project-actions.js';

const PROJECT_ROUTE = /^\/projects\/([^/]+)\/(feedback-preview)$/;
const MODES = ['exact', 'estimate'];
const PURPOSES = ['personas', 'research'];
// projects.persona_context_budget's item limit on a 200K-token model.
const PERSONA_SAMPLE_LIMIT = 145;

const bad = (error) => [400, { success: false, error }];

function feedbackPreview(shared, body) {
  const purpose = body.purpose ?? 'personas';
  if (!MODES.includes(body.mode)) return bad(`mode must be one of: ${MODES.join(', ')}`);
  if (!PURPOSES.includes(purpose)) return bad(`purpose must be one of: ${PURPOSES.join(', ')}`);
  return [200, {
    matched: matchingFeedback(shared, body).length,
    matched_is_lower_bound: false,
    estimated: body.mode === 'estimate',
    sample_limit: purpose === 'personas' ? PERSONA_SAMPLE_LIMIT : null,
  }];
}

/** Handle this module's routes; returns true when the request was taken. */
export function handlePersonaRoutes(req, res, url, send, shared) {
  const match = url.pathname.match(PROJECT_ROUTE);
  if (!match || req.method !== 'POST') return false;
  if (!shared.mockProjectDetails[decodeURIComponent(match[1])]) {
    send(404, { success: false, error: 'Project not found' });
    return true;
  }
  shared.collectJson(req, res, (raw) => {
    const body = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    send(...feedbackPreview(shared, body));
  });
  return true;
}
