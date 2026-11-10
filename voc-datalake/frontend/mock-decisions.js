// Decision records + release watch mocks (docs/decisions-and-release-watch.md).
// Wire shapes follow lambda/shared/decision_records.py (POST /projects/{id}/decisions,
// PUT /projects/{id}/decisions/{document_id}, POST .../{document_id}/pursue) and
// lambda/shared/release_watch.py (GET /metrics/release-watch).
//
// Stateful for the life of the mock process: a decision is a `DOC#` document in the
// shared `mockProjectDetails` store, so GET /projects/{id} lists it; "Pursue" starts
// the ordinary mock PR/FAQ job. Wired into mock-server.js by handleDomainModules.

import { startMockDocumentGeneration } from './mock-project-actions.js';

const DECISION_PATH = /^\/projects\/([^/]+)\/decisions(?:\/([^/]+)(\/pursue)?)?$/;
const VERDICTS = ['pursue', 'park', 'reject'];
const ID = /^[A-Za-z0-9_.:#-]{1,128}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MOCK_CALLER = { decided_by: 'sub-admin-demo', decided_by_name: 'admin-demo' };
const LIMITS = { title: 200, rationale: 4000, success_metric: 1000, kill_criterion: 1000 };

const bad = (error) => [400, { success: false, error }];
const nowIso = () => new Date().toISOString();
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const dayOffset = (days) => new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);

function idList(value, name, limit) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > limit || !value.every((v) => typeof v === 'string' && ID.test(v))) {
    throw new Error(`evidence.${name} must be a list of at most ${limit} ids`);
  }
  return [...new Set(value)];
}

function textField(body, name) {
  const value = body[name];
  if ((value === undefined || value === null) && name !== 'rationale' && name !== 'title') return '';
  if (typeof value !== 'string' || ((name === 'rationale' || name === 'title') && value.trim() === '')) {
    throw new Error(`${name} is required`);
  }
  if (value.trim().length > LIMITS[name]) throw new Error(`${name} must be at most ${LIMITS[name]} characters`);
  return value.trim();
}

function dayField(body, name) {
  const value = body[name];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !DAY.test(value)) throw new Error(`${name} must be a YYYY-MM-DD date`);
  return value;
}

function verdictField(body) {
  if (!VERDICTS.includes(body.verdict)) throw new Error(`verdict must be one of: ${VERDICTS.join(', ')}`);
  return body.verdict;
}

function evidenceField(body) {
  const evidence = isObject(body.evidence) ? body.evidence : {};
  return {
    feedback_ids: idList(evidence.feedback_ids, 'feedback_ids', 50),
    document_ids: idList(evidence.document_ids, 'document_ids', 20),
  };
}

const FIELD_READERS = {
  title: (body) => textField(body, 'title'),
  verdict: verdictField,
  rationale: (body) => textField(body, 'rationale'),
  success_metric: (body) => textField(body, 'success_metric'),
  kill_criterion: (body) => textField(body, 'kill_criterion'),
  evidence: evidenceField,
  review_by: (body) => dayField(body, 'review_by'),
  launched_at: (body) => dayField(body, 'launched_at'),
};

/** validated_fields: every field on a create, only the sent ones on an edit. */
function fields(body, partial) {
  const names = Object.keys(FIELD_READERS).filter((name) => !partial || Object.hasOwn(body, name));
  if (partial && names.length === 0) throw new Error('Send at least one field');
  return Object.fromEntries(names.map((name) => [name, FIELD_READERS[name](body)]));
}

function render(title, decision) {
  const verdict = decision.verdict.charAt(0).toUpperCase() + decision.verdict.slice(1);
  return `# ${title}\n\n**Verdict:** ${verdict}\n\n## Rationale\n\n${decision.rationale}\n`;
}

function derivation(decision) {
  const docs = decision.evidence?.document_ids ?? [];
  return {
    sources: docs.map((id) => ({ document_id: id, role: 'reference' })), selected_document_count: docs.length,
    feedback_count: decision.evidence?.feedback_ids?.length ?? 0, persona_ids: [], visual_document_ids: [],
    product_context_included: false,
  };
}

function createDecision(detail, body, shared) {
  const { title, ...rest } = fields(body, false);
  const at = nowIso();
  const decision = { ...rest, ...MOCK_CALLER, decided_at: at, history: [] };
  const doc = {
    document_id: shared.nextMockId('doc'), document_type: 'decision', title, content: render(title, decision),
    decision, derivation: derivation(decision), revision: 1, created_at: at, updated_at: at,
  };
  detail.documents.push(doc);
  return [200, { success: true, document: doc }];
}

function updateDecision(detail, documentId, body) {
  const doc = detail.documents.find((d) => d.document_id === documentId && d.document_type === 'decision');
  if (!doc) return [404, { success: false, error: 'Decision not found' }];
  if (body.expected_revision !== undefined && body.expected_revision !== doc.revision) {
    return [409, { success: false, error: 'This decision changed since you opened it. Reload it and try again.' }];
  }
  const { title, ...changes } = fields(body, true);
  const at = nowIso();
  const verdictChanged = changes.verdict !== undefined && changes.verdict !== doc.decision.verdict;
  const history = verdictChanged
    ? [...doc.decision.history, { verdict: doc.decision.verdict, decided_by: doc.decision.decided_by, decided_at: doc.decision.decided_at }]
    : doc.decision.history;
  const decision = { ...doc.decision, ...changes, history, ...(verdictChanged ? { ...MOCK_CALLER, decided_at: at } : {}) };
  Object.assign(doc, {
    title: title ?? doc.title, decision, derivation: derivation(decision), revision: doc.revision + 1, updated_at: at,
  });
  doc.content = render(doc.title, decision);
  return [200, { success: true, document: doc }];
}

function pursueDecision(detail, documentId, body, shared, projectId) {
  const doc = detail.documents.find((d) => d.document_id === documentId && d.document_type === 'decision');
  if (!doc) return [404, { success: false, error: 'Decision not found' }];
  if (doc.decision.verdict !== 'pursue') return bad('Only a Pursue decision seeds a PR/FAQ');
  const [status, started] = startMockDocumentGeneration(projectId, {
    doc_type: 'prfaq', title: doc.title, feature_idea: doc.decision.rationale,
    selected_document_ids: [doc.document_id], response_language: body?.response_language,
  }, shared);
  if (status !== 200) return [status, started];
  doc.seeded_prfaq_job_id = started.job_id;
  doc.seeded_prfaq_at = nowIso();
  return [202, { success: true, job_id: started.job_id, status: 'pending' }];
}

function side(days, count, negative, sentiment, categories) {
  return { days, count, scored: count, avg_sentiment: sentiment, negative, top_categories: categories };
}

/** A fixed, realistic release watch: one regressed GitHub release, one healthy one, or the named launch. */
function releaseWatch(params) {
  const window = Math.min(Math.max(Number(params.get('window')) || 14, 1), 60);
  const launchedAt = params.get('launched_at');
  if (launchedAt !== null && !DAY.test(launchedAt)) return bad('launched_at must be a YYYY-MM-DD date');
  const base = { period_days: Number(params.get('days')) || 90, window_days: window, is_partial: false,
    thresholds: { sentiment_drop: 0.15, negative_rise_pct: 50, min_negative_items: 10, min_sentiment_items: 5 } };
  if (launchedAt !== null) {
    return [200, { ...base, releases: [{
      key: `launch:${launchedAt}`, label: params.get('label') || launchedAt, kind: 'launch', date: launchedAt,
      before: side(window, 18, 4, 0.21, [{ name: 'delivery', count: 9 }, { name: 'pricing', count: 5 }, { name: 'website', count: 3 }]),
      after: side(window, 22, 5, 0.18, [{ name: 'delivery', count: 10 }, { name: 'product_quality', count: 6 }, { name: 'pricing', count: 4 }]),
      deltas: { volume_pct: 22, negative_pct: 25, sentiment: -0.03 },
      complaint_deltas: [{ name: 'delivery', before: 2, after: 4 }], regression: false, reasons: [], feedback_ids: ['fb_1'],
      evidence: [{ feedback_id: 'fb_1', title: 'Parcel arrived two days late' }],
    }] }];
  }
  return [200, { ...base, releases: [
    {
      key: 'github:2.4.0', label: '2.4.0', kind: 'github_release', date: dayOffset(6),
      // Ranked (release_watch.TOP_CATEGORIES = 3), configured ids: the card shows their labels.
      // After: the app grew, pricing is new in the top three, delivery dropped out.
      before: side(window, 30, 6, 0.24, [{ name: 'app', count: 12 }, { name: 'delivery', count: 8 }, { name: 'customer_support', count: 5 }]),
      after: side(7, 34, 14, -0.05, [{ name: 'app', count: 19 }, { name: 'pricing', count: 7 }, { name: 'customer_support', count: 4 }]),
      deltas: { volume_pct: 127, negative_pct: 367, sentiment: -0.29 },
      // Only complaints that grew by 2 or more (release_watch.MIN_COMPLAINT_GROWTH).
      complaint_deltas: [{ name: 'app', before: 3, after: 10 }, { name: 'pricing', before: 1, after: 3 }],
      regression: true, reasons: ['sentiment_drop', 'negative_rise'], feedback_ids: ['fb_1', 'fb_2', 'fb_3'],
      evidence: [
        { feedback_id: 'fb_1', title: 'App crashes when I open my orders' },
        { feedback_id: 'fb_2', title: 'Since the update I cannot log…' },
        { feedback_id: 'fb_3', title: 'Charged twice for one order' },
      ],
    },
    {
      key: 'github:2.3.1', label: '2.3.1', kind: 'github_release', date: dayOffset(30),
      before: side(window, 25, 5, 0.2, [{ name: 'app', count: 9 }, { name: 'website', count: 7 }, { name: 'delivery', count: 4 }]),
      after: side(window, 27, 5, 0.23, [{ name: 'app', count: 10 }, { name: 'website', count: 6 }, { name: 'delivery', count: 5 }]),
      deltas: { volume_pct: 8, negative_pct: 0, sentiment: 0.03 },
      complaint_deltas: [], regression: false, reasons: [], feedback_ids: [], evidence: [],
    },
  ] }];
}

function decisionRoute(req, match, body, shared) {
  const [, projectId, documentId, pursue] = match;
  const detail = shared.mockProjectDetails[decodeURIComponent(projectId)];
  if (!detail) return [404, { success: false, error: 'Project not found' }];
  if (!isObject(body)) return bad('Request body must be a JSON object');
  try {
    if (req.method === 'POST' && documentId === undefined) return createDecision(detail, body, shared);
    if (req.method === 'PUT' && documentId !== undefined && pursue === undefined) return updateDecision(detail, decodeURIComponent(documentId), body);
    if (req.method === 'POST' && pursue !== undefined) {
      return pursueDecision(detail, decodeURIComponent(documentId), body, shared, decodeURIComponent(projectId));
    }
  } catch (error) {
    return bad(error instanceof Error ? error.message : String(error));
  }
  return [405, { success: false, error: 'Method not allowed' }];
}

export function handleDecisionRoutes(req, res, url, send, shared) {
  if (req.method === 'GET' && url.pathname === '/metrics/release-watch') {
    send(...releaseWatch(url.searchParams));
    return true;
  }
  const match = url.pathname.match(DECISION_PATH);
  if (!match) return false;
  shared.collectJson(req, res, (body) => send(...decisionRoute(req, match, body, shared)));
  return true;
}
