// Dev-mock routes and stream events for persona focus groups (7.64.00, docs/project-workspace.md → Persona focus
// groups), in the wire shape of lambda/shared/persona_grounding_routes.py and the stream's runtime/focus-group.ts:
//
//   GET  /projects/{id}/personas/{pid}/evidence-freshness
//        -> {persona_id, since, count, count_is_lower_bound, refreshed_at, updates}
//   POST /projects/{id}/personas/{pid}/evidence/refresh
//        -> {success, persona_id, added, evidence_updates, evidence_refreshed_at}; 404 for an unknown persona
//   POST /chat/stream with forwardedProps.focusGroup -> focusGroupEvents(): per round one assistant message of
//        consult_personas calls (`focus_r{n}_…`), the moderator's follow-up between rounds, the synthesis text and
//        CUSTOM assistant.focus_group (running, then finished).
//
// The freshness count is the fixture feedback newer than the persona (none of the fixtures are, so a persona shows
// two new reviews until refreshed: a stable mock beats fake freshness); a refresh moves them into its evidence.

const FRESHNESS_ROUTE = /^\/projects\/([^/]+)\/personas\/([^/]+)\/evidence-freshness$/;
const REFRESH_ROUTE = /^\/projects\/([^/]+)\/personas\/([^/]+)\/evidence\/refresh$/;
const MOCK_NEW_REVIEWS = 2;
const MAX_EVIDENCE_UPDATES = 20;

function freshIds(shared, persona) {
  const stored = new Set((persona.evidence_updates ?? []).flatMap((entry) => entry.feedback_ids ?? []));
  return shared.mockFeedback.slice(0, MOCK_NEW_REVIEWS).map((item) => item.feedback_id).filter((id) => !stored.has(id));
}

function sinceOf(persona) {
  return String(persona.evidence_refreshed_at ?? persona.created_at ?? new Date().toISOString()).slice(0, 10);
}

function freshness(shared, persona) {
  return [200, {
    persona_id: persona.persona_id, since: sinceOf(persona), count: freshIds(shared, persona).length,
    count_is_lower_bound: false, refreshed_at: persona.evidence_refreshed_at ?? null,
    updates: (persona.evidence_updates ?? []).length,
  }];
}

function refresh(shared, persona) {
  const ids = freshIds(shared, persona);
  if (ids.length === 0) {
    return [200, { success: true, persona_id: persona.persona_id, added: 0, evidence_updates: persona.evidence_updates ?? [],
      evidence_refreshed_at: persona.evidence_refreshed_at ?? null }];
  }
  const at = new Date().toISOString();
  const entry = { at, by: { sub: shared.mockCaller.sub, kind: 'user' }, reason: 'manual_refresh', feedback_ids: ids };
  persona.evidence_updates = [...(persona.evidence_updates ?? []), entry].slice(-MAX_EVIDENCE_UPDATES);
  persona.evidence_refreshed_at = at;
  return [200, { success: true, persona_id: persona.persona_id, added: ids.length, evidence_updates: persona.evidence_updates,
    evidence_refreshed_at: at }];
}

/** `[kind, project id, persona id]` for a request this module owns, or null. */
function ownRoute(req, url) {
  const fresh = req.method === 'GET' ? url.pathname.match(FRESHNESS_ROUTE) : null;
  if (fresh) return ['freshness', fresh[1], fresh[2]];
  const again = req.method === 'POST' ? url.pathname.match(REFRESH_ROUTE) : null;
  return again ? ['refresh', again[1], again[2]] : null;
}

/** Handle this module's routes; returns true when the request was taken. */
export function handleFocusGroupRoutes(req, res, url, send, shared) {
  const route = ownRoute(req, url);
  if (!route) return false;
  const [kind, projectId, personaId] = route;
  const detail = shared.mockProjectDetails[decodeURIComponent(projectId)];
  const persona = detail?.personas.find((p) => p.persona_id === decodeURIComponent(personaId));
  if (!detail || !persona) {
    send(404, { success: false, error: detail ? 'Persona not found' : 'Project not found' });
    return true;
  }
  send(...(kind === 'freshness' ? freshness(shared, persona) : refresh(shared, persona)));
  return true;
}

function text(id, delta) {
  return [
    { type: 'TEXT_MESSAGE_START', messageId: id, role: 'assistant' },
    { type: 'TEXT_MESSAGE_CONTENT', messageId: id, delta },
    { type: 'TEXT_MESSAGE_END', messageId: id },
  ];
}

function roundEvents(personas, round, question, review, nextMockId) {
  const parent = nextMockId('msg');
  const calls = personas.map((persona) => ({ persona, id: `focus_r${round}_${nextMockId('call').replace(/[^\w]/g, '')}` }));
  const starts = calls.flatMap(({ persona, id }) => [
    { type: 'TOOL_CALL_START', toolCallId: id, toolCallName: 'consult_personas', parentMessageId: parent },
    { type: 'TOOL_CALL_ARGS', toolCallId: id, delta: JSON.stringify({ question, persona_ids: [persona.persona_id] }) },
    { type: 'TOOL_CALL_END', toolCallId: id },
  ]);
  const results = calls.map(({ persona, id }) => ({
    type: 'TOOL_CALL_RESULT', messageId: nextMockId('msg'), toolCallId: id, role: 'tool',
    content: JSON.stringify({ responses: [{
      persona_id: persona.persona_id, name: persona.name, round,
      answer: round === 1
        ? `As ${persona.name} (mock): delivery reliability matters most to me [fb:${review.feedback_id}].`
        : `As ${persona.name} (mock): I agree with another participant, and I would add clearer tracking.`,
      citations: round === 1 ? [{ feedback_id: review.feedback_id, text: review.original_text, source_platform: review.source_platform }] : [],
    }] }),
  }));
  return [...starts, ...results];
}

/** A focus group run's events (before RUN_FINISHED), or [] off a project page. */
export function focusGroupEvents(detail, focusGroup, topic, shared) {
  if (!detail) return [];
  const wanted = detail.personas.filter((p) => focusGroup.persona_ids.includes(p.persona_id));
  const review = shared.mockFeedback[0];
  const config = focusGroup;
  const missing = focusGroup.persona_ids.filter((id) => !wanted.some((p) => p.persona_id === id));
  const rounds = Array.from({ length: focusGroup.rounds }, (_, index) => index + 1).flatMap((round) => [
    ...(round > 1 ? text(shared.nextMockId('msg'), 'What would make the delivery experience worth paying for? (mock)') : []),
    ...roundEvents(wanted, round, topic, review, shared.nextMockId),
  ]);
  const synthesis = {
    agreements: [`Everyone wants reliable deliveries [fb:${review.feedback_id}].`],
    disagreements: ['They differ on whether faster delivery is worth a higher price.'],
    open_questions: ['Would customers pay for a guaranteed slot?'],
  };
  return [
    { type: 'CUSTOM', name: 'assistant.focus_group', value: { status: 'running', config, rounds_completed: 0, cited_feedback_ids: [], missing_persona_ids: missing } },
    ...rounds,
    ...text(shared.nextMockId('msg'), '**Agreements**\n- Everyone wants reliable deliveries.\n\n_Synthetic: the personas\' statements are hypotheses to test, never customer feedback._'),
    { type: 'CUSTOM', name: 'assistant.focus_group', value: {
      status: 'finished', config, rounds_completed: focusGroup.rounds, synthesis,
      cited_feedback_ids: [review.feedback_id], missing_persona_ids: missing,
    } },
    { type: 'CUSTOM', name: 'assistant.sources', value: { feedback: [{ feedback_id: review.feedback_id, text: review.original_text,
      source_platform: review.source_platform, sentiment_label: review.sentiment_label }], web: [], library: [] } },
  ];
}
