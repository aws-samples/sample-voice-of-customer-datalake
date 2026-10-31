// Dev-mock routes for the persona and research wizards' persona extras (ported from #429 by @aws-bryan),
// in the wire shape of lambda/api/projects_handler.py:
//
//   POST /projects/{id}/feedback-preview  {sources, categories, sentiments, days, mode, purpose}
//        -> {matched, matched_is_lower_bound, estimated, sample_limit}   (projects.preview_feedback)
//   PUT  /projects/{id}/personas/{pid}/protection  {protected: boolean}
//        -> {success, persona_id, protected}; 400 for a non-boolean, 404 for an unknown persona
//        (projects.set_persona_protection; a replace generation then keeps it, mock-project-actions.js)
//
// Counted from the shared fixture feedback like the F1 pre-check in mock-project-actions.js: an empty
// list matches everything and `days` is not applied (the fixture dates are static). The estimate
// answers the same count, so the wizard's "About N … confirming" line settles on the exact one.

import { matchingFeedback } from './mock-project-actions.js';

const PREVIEW_ROUTE = /^\/projects\/([^/]+)\/feedback-preview$/;
const PROTECTION_ROUTE = /^\/projects\/([^/]+)\/personas\/([^/]+)\/protection$/;
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

function setProtection(detail, personaId, body) {
  if (typeof body.protected !== 'boolean') return bad('protected must be true or false');
  const persona = Array.isArray(detail.personas) ? detail.personas.find((p) => p.persona_id === personaId) : undefined;
  if (!persona) return [404, { success: false, error: 'Persona not found' }];
  persona.protected = body.protected;
  persona.updated_at = new Date().toISOString();
  return [200, { success: true, persona_id: personaId, protected: body.protected }];
}

/** `[route, project id, persona id]` for a request this module owns, or null. */
function ownRoute(req, url) {
  const preview = req.method === 'POST' ? url.pathname.match(PREVIEW_ROUTE) : null;
  if (preview) return ['preview', preview[1], null];
  const protection = req.method === 'PUT' ? url.pathname.match(PROTECTION_ROUTE) : null;
  return protection ? ['protection', protection[1], protection[2]] : null;
}

/** Handle this module's routes; returns true when the request was taken. */
export function handlePersonaRoutes(req, res, url, send, shared) {
  const route = ownRoute(req, url);
  if (!route) return false;
  const [kind, projectId, personaId] = route;
  const detail = shared.mockProjectDetails[decodeURIComponent(projectId)];
  if (!detail) {
    send(404, { success: false, error: 'Project not found' });
    return true;
  }
  shared.collectJson(req, res, (raw) => {
    const body = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    send(...(kind === 'preview' ? feedbackPreview(shared, body) : setProtection(detail, decodeURIComponent(personaId), body)));
  });
  return true;
}
