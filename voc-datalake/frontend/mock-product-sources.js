// Dev-mock routes of the Product tab's sources, extract and proposals (7.104.00, docs/project-workspace.md → Product
// tab), in the wire shape of lambda/shared/product_source_routes.py and product_proposal_routes.py:
//
//   POST /projects/{id}/product-docs/{doc}/uploaded   -> 202 {doc}: a PDF, DOCX or PPTX is read (ready ~3 s later)
//   POST /projects/{id}/product-docs/urls {url}       -> 201 {doc}: a link, fetched (ready ~3 s later); 400 not https
//   POST /projects/{id}/product-docs/{doc}/refresh    -> 202 {doc}: a link, or a failed PDF, DOCX or PPTX, read again;
//                                                        409 not_refreshable (MD, TXT, an image, answers), extracting,
//                                                        not_failed
//   POST /projects/{id}/product-docs/answers          -> 201 {doc}: typed answers as a ready interview source
//   POST /projects/{id}/product-extract               -> 202 {job_id}; 400 no_ready_sources; 409 extract_running
//   GET  /projects/{id}/product-proposals/latest      -> {proposal | null, context, field_meta, sources}
//   POST /projects/{id}/product-proposals/{pid}/accept  -> {applied, conflicts, status}; 409 conflict when every field
//                                                          conflicts, 409 proposal_closed once it is not open
//   POST /projects/{id}/product-proposals/{pid}/dismiss -> {proposal_id, status: 'dismissed'}; 409 proposal_closed once
//                                                          applied or superseded
//
// The product docs list, its upload URL and delete stay in mock-server.js (shared.mockProductDocs); the extract runs
// as a listed project job (shared.startMockProjectJob, mock-project-actions.js), whose completion writes the proposal.
// The proposal is scripted and cites the first ready source; product names in it are neutral samples.

const READ_MS = 3000;
const MAX_SOURCES = 20;
const FIELDS = [
  'product_summary', 'product_name', 'one_liner', 'current_state', 'target_users', 'problem_solved', 'key_features',
  'differentiators', 'success_metrics', 'known_limitations', 'non_goals', 'free_form_notes',
];
const TWIN_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

const proposals = {}; // projectId -> proposal[] (newest last)
const fieldMeta = {}; // projectId -> { field: {by, sub, at} }

const nowIso = () => new Date().toISOString();

/** A source row with the nine 7.104.00 fields (null or false where they do not apply). */
export function productDocRow(fields) {
  return {
    filename: '', content_type: 'application/octet-stream', size_bytes: 0, status: 'pending', error: null,
    extracted_chars: 0, created_at: nowIso(), source_kind: 'file', injection_flag: false, method: null, pages: null,
    truncated: false, url: null, final_url: null, title: null, interview_mode: null, ...fields,
  };
}

/** Whether a PUT's content type is read by the twin (announced with …/uploaded) rather than the S3 extractor. */
export const isTwinRead = (contentType) => TWIN_TYPES.has(contentType);

/** Finish the readings whose time has come (a list read calls this), as the twin would. */
export function advanceProductDocs(docs) {
  const now = Date.now();
  for (const doc of docs) {
    if (doc.status !== 'extracting' || (doc.ready_at ?? 0) > now) continue;
    delete doc.ready_at;
    if (doc.source_kind === 'url') {
      Object.assign(doc, { status: 'ready', title: 'Sample product page (mock)', final_url: doc.url, extracted_chars: 4200, method: 'text' });
    } else {
      Object.assign(doc, { status: 'ready', extracted_chars: 12_800, pages: 6, method: 'text' });
    }
  }
}

/** The form's own saves mark their fields as a person's (PUT …/product-context, mock-server.js). */
export function markPersonFields(projectId, body, sub) {
  const meta = fieldMeta[projectId] ?? (fieldMeta[projectId] = {});
  for (const field of FIELDS) {
    if (typeof body?.[field] === 'string') meta[field] = { by: 'person', sub, at: nowIso() };
  }
}

/** A voice interview's answers as a ready interview source (mock-voice.js, at its end). */
export function addInterviewSource(shared, projectId, { mode, sessionId = null, text }) {
  const docs = shared.mockProductDocs[projectId] ?? (shared.mockProductDocs[projectId] = []);
  if (docs.length >= MAX_SOURCES) return null;
  const doc = productDocRow({
    doc_id: shared.nextMockId('doc'), filename: `answers-${mode}.md`, content_type: 'text/markdown', size_bytes: text.length,
    status: 'ready', extracted_chars: text.length, source_kind: 'interview', interview_mode: mode, method: 'text', session_id: sessionId,
  });
  docs.push(doc);
  return doc;
}

const docsOf = (shared, projectId) => shared.mockProductDocs[projectId] ?? (shared.mockProductDocs[projectId] = []);

function addUrl(shared, projectId, body) {
  const url = typeof body?.url === 'string' ? body.url.trim() : '';
  if (!url.startsWith('https://') || url.length > 2048) {
    return [400, { success: false, error: 'This address is not allowed (only public https pages can be read)', code: 'url_not_allowed' }];
  }
  const docs = docsOf(shared, projectId);
  const added = docs.find((doc) => doc.url === url);
  if (added) return [409, { success: false, error: `This link is already a source of this project: "${url}".`, code: 'duplicate', doc_id: added.doc_id }];
  if (docs.length >= MAX_SOURCES) return [400, { success: false, error: 'A project has at most 20 sources', code: 'too_many_sources' }];
  const doc = productDocRow({ doc_id: shared.nextMockId('doc'), filename: url, content_type: 'text/html', source_kind: 'url', url, status: 'extracting', ready_at: Date.now() + READ_MS });
  docs.push(doc);
  return [201, { success: true, doc }];
}

function answersText(answers) {
  return answers.map((one) => `**Question:** ${one.question}\n\n**Answer:** ${one.answer}`).join('\n\n');
}

function saveAnswers(shared, projectId, body) {
  if (body?.mode !== 'typed') return [400, { success: false, error: "mode must be 'typed' (a voice interview is saved when it ends)" }];
  if (!Array.isArray(body?.answers) || body.answers.length === 0 || body.answers.length > 12) {
    return [400, { success: false, error: 'answers must be a list of 1 to 12 answers' }];
  }
  const answers = body.answers.filter((one) => typeof one?.answer === 'string' && one.answer.trim() !== '');
  if (answers.length === 0) return [400, { success: false, error: 'Write at least one answer.', code: 'no_answers' }];
  const doc = addInterviewSource(shared, projectId, { mode: 'typed', text: answersText(answers) });
  return doc ? [201, { success: true, doc }] : [400, { success: false, error: 'A project has at most 20 sources', code: 'too_many_sources' }];
}

/** Read on the twin, so `…/refresh` may read it again: a link, or a PDF, DOCX or PPTX upload. */
const readOnTwin = (doc) => doc.source_kind === 'url' || isTwinRead(doc.content_type);

/** Why `…/refresh` refuses a source (shared/product_source_routes.py refresh_product_doc), or null to read it. */
function refreshRefusal(doc) {
  if (!readOnTwin(doc)) {
    return [409, { success: false, error: 'This source is read when it is added. Delete it and add it again.', code: 'not_refreshable' }];
  }
  if (doc.status === 'extracting') return [409, { success: false, error: 'This source is being read. Wait for it to finish.', code: 'extracting' }];
  if (doc.source_kind !== 'url' && doc.status !== 'failed') {
    return [409, { success: false, error: 'Only a source whose read failed can be read again.', code: 'not_failed' }];
  }
  return null;
}

function reread(shared, projectId, docId, kind) {
  const doc = docsOf(shared, projectId).find((one) => one.doc_id === docId);
  if (!doc) return [404, { success: false, error: 'Source not found' }];
  // …/uploaded is idempotent: a source already claimed, read or failed, and one the S3 extractor reads, as it is.
  if (kind === 'uploaded' && (doc.status !== 'pending' || !readOnTwin(doc))) return [202, { success: true, doc }];
  const refused = kind === 'refresh' ? refreshRefusal(doc) : null;
  if (refused) return refused;
  Object.assign(doc, { status: 'extracting', error: null, ready_at: Date.now() + READ_MS });
  return [202, { success: true, doc }];
}

function citation(source, quote, verified = true) {
  return source ? [{ source_id: 'S1', quote, page: source.pages === null ? null : 1, verified }] : [];
}

/** The scripted proposal: a value, a conflict with a typed value, gaps with questions, an unverified quote. */
function scriptedFields(context, source) {
  const proposed = (value, quote, confidence = 'high', verified = true) => ({
    status: 'proposed', value, citations: citation(source, quote, verified), confidence, note: '',
  });
  const gap = { status: 'gap', value: '', citations: [], confidence: 'low', note: 'No source says this.' };
  const raw = {
    product_summary: proposed('A delivery-tracking app that tells people when a parcel will arrive and lets them reschedule it (mock).', 'tells people when a parcel will arrive'),
    product_name: proposed('Parcel Pilot', 'Parcel Pilot'),
    one_liner: proposed('Parcel arrival times you can plan around, for busy households (mock).', 'arrival times you can plan around'),
    current_state: proposed('beta', 'now in public beta', 'medium'),
    target_users: proposed('Online shoppers who are not home during the day (mock).', 'people who are out at work', 'medium', false),
    problem_solved: proposed('Missed deliveries and long waits at home (mock).', 'missed deliveries'),
    key_features: proposed('Live arrival window; one-tap reschedule; safe-place notes (mock).', 'one-tap reschedule'),
    differentiators: gap,
    success_metrics: gap,
    known_limitations: { status: 'proposed', value: 'Works only with partner carriers (mock).', citations: [], confidence: 'low', note: 'No verified source.' },
    non_goals: gap,
    free_form_notes: { status: 'unchanged', value: context.free_form_notes, citations: [], confidence: 'high', note: '' },
  };
  const fields = {};
  for (const field of FIELDS) {
    const seen = context[field] ?? '';
    const one = raw[field];
    const status = one.status === 'proposed' && seen !== '' && seen !== one.value ? 'conflict' : one.status;
    fields[field] = { ...one, status: seen === one.value ? 'unchanged' : status, seen, accepted: false };
  }
  return fields;
}

function writeProposal(shared, projectId, jobId, effort) {
  const context = shared.getProductContext(projectId);
  const ready = docsOf(shared, projectId).filter((doc) => doc.status === 'ready');
  const sources = ready.map((doc, index) => ({
    source_id: `S${index + 1}`, doc_id: doc.doc_id, name: doc.title ?? doc.filename, kind: doc.source_kind,
    chars_sent: Math.min(doc.extracted_chars, 40_000), cut: doc.extracted_chars > 40_000,
  }));
  for (const older of proposals[projectId] ?? []) if (older.status === 'open' || older.status === 'partly_applied') older.status = 'superseded';
  const proposal = {
    proposal_id: `pp_${shared.nextMockId('x').replace(/\W/g, '')}`, status: 'open', job_id: jobId, created_at: nowIso(),
    model_id: 'global.anthropic.claude-sonnet-5-5', effort, sources, skipped_sources: [],
    fields: scriptedFields(context, ready[0]),
    questions: [
      { field: 'differentiators', question: 'Which alternatives do customers compare it with, and what makes it different? (mock)' },
      { field: 'success_metrics', question: 'Which numbers tell you it is working? (mock)' },
      { field: 'non_goals', question: 'What will it deliberately not do? (mock)' },
    ],
  };
  proposals[projectId] = [...(proposals[projectId] ?? []), proposal];
  return { proposal_id: proposal.proposal_id };
}

function startExtract(shared, projectId, body) {
  if (!docsOf(shared, projectId).some((doc) => doc.status === 'ready')) {
    return [400, { success: false, error: 'No source is ready yet', code: 'no_ready_sources' }];
  }
  const effort = body?.effort === 'xhigh' ? 'xhigh' : 'max';
  const holder = { jobId: '' };
  const [, started] = shared.startMockProjectJob(projectId, 'extract_product_description', {
    runningStep: 'thinking', errorMessage: 'The extract failed',
    complete: () => writeProposal(shared, projectId, holder.jobId, effort),
  });
  holder.jobId = started.job_id;
  return [202, { success: true, job_id: started.job_id }];
}

/** The latest proposal with every field's `current` and `changed_since`, and each cited source's `deleted`. */
function latest(shared, projectId) {
  const context = shared.getProductContext(projectId);
  const docs = docsOf(shared, projectId);
  advanceProductDocs(docs);
  const newest = (proposals[projectId] ?? []).at(-1) ?? null;
  const proposal = newest && {
    ...newest,
    sources: newest.sources.map((source) => ({ ...source, deleted: !docs.some((doc) => doc.doc_id === source.doc_id) })),
    fields: Object.fromEntries(FIELDS.map((field) => {
      const one = newest.fields[field];
      const current = context[field] ?? '';
      return [field, { ...one, current, changed_since: !one.accepted && current !== one.seen }];
    })),
  };
  return [200, { proposal, context, field_meta: fieldMeta[projectId] ?? {}, sources: docs }];
}

/** The accept's and the dismiss's refusal of a proposal no longer open (shared/product_proposals.py). */
const PROPOSAL_CLOSED = [409, { success: false, error: 'This proposal is closed: extract again for a new one', code: 'proposal_closed' }];
const isOpen = (proposal) => proposal.status === 'open' || proposal.status === 'partly_applied';

function accept(shared, projectId, proposalId, body) {
  const proposal = (proposals[projectId] ?? []).find((one) => one.proposal_id === proposalId);
  if (!proposal) return [404, { success: false, error: 'Proposal not found' }];
  if (!isOpen(proposal)) return PROPOSAL_CLOSED;
  const context = shared.getProductContext(projectId);
  const applied = [];
  const conflicts = [];
  for (const [field, choice] of Object.entries(body?.fields ?? {})) {
    if (!FIELDS.includes(field) || typeof choice?.seen !== 'string') continue;
    if ((context[field] ?? '') !== choice.seen) {
      conflicts.push({ field, reason: 'changed' });
      continue;
    }
    context[field] = typeof choice.value === 'string' ? choice.value : proposal.fields[field].value;
    proposal.fields[field].accepted = true;
    const meta = fieldMeta[projectId] ?? {};
    meta[field] = { by: 'extract', sub: shared.mockCaller.sub, at: nowIso(), proposal_id: proposalId };
    fieldMeta[projectId] = meta;
    applied.push(field);
  }
  if (applied.length === 0 && conflicts.length > 0) {
    return [409, { success: false, error: 'Every field changed since the extract, or is a value a person typed', code: 'conflict', conflicts, applied: [], status: proposal.status }];
  }
  const open = FIELDS.some((field) => ['proposed', 'conflict'].includes(proposal.fields[field].status) && !proposal.fields[field].accepted);
  proposal.status = open ? 'partly_applied' : 'applied';
  context.updated_at = nowIso();
  return [200, { applied, conflicts, status: proposal.status }];
}

function dismiss(projectId, proposalId) {
  const proposal = (proposals[projectId] ?? []).find((one) => one.proposal_id === proposalId);
  if (!proposal) return [404, { success: false, error: 'Proposal not found' }];
  // Dismissed again: the same answer; applied or superseded: closed.
  if (proposal.status !== 'dismissed' && !isOpen(proposal)) return PROPOSAL_CLOSED;
  proposal.status = 'dismissed';
  return [200, { proposal_id: proposalId, status: 'dismissed' }];
}

const ROUTES = [
  { method: 'POST', pattern: /^\/projects\/([^/]+)\/product-docs\/urls$/, run: (shared, [projectId], body) => addUrl(shared, projectId, body) },
  { method: 'POST', pattern: /^\/projects\/([^/]+)\/product-docs\/answers$/, run: (shared, [projectId], body) => saveAnswers(shared, projectId, body) },
  { method: 'POST', pattern: /^\/projects\/([^/]+)\/product-docs\/([^/]+)\/(uploaded|refresh)$/, run: (shared, [projectId, docId, kind]) => reread(shared, projectId, docId, kind) },
  { method: 'POST', pattern: /^\/projects\/([^/]+)\/product-extract$/, run: (shared, [projectId], body) => startExtract(shared, projectId, body) },
  { method: 'GET', pattern: /^\/projects\/([^/]+)\/product-proposals\/latest$/, run: (shared, [projectId]) => latest(shared, projectId) },
  { method: 'POST', pattern: /^\/projects\/([^/]+)\/product-proposals\/([^/]+)\/accept$/, run: (shared, [projectId, pid], body) => accept(shared, projectId, pid, body) },
  { method: 'POST', pattern: /^\/projects\/([^/]+)\/product-proposals\/([^/]+)\/dismiss$/, run: (_shared, [projectId, pid]) => dismiss(projectId, pid) },
];

/** Handle this module's routes; returns true when the request was taken. */
export function handleProductSourceRoutes(req, res, url, send, shared) {
  const route = ROUTES.find((one) => one.method === req.method && one.pattern.test(url.pathname));
  if (!route) return false;
  const groups = url.pathname.match(route.pattern).slice(1).map((part) => decodeURIComponent(part));
  if (!shared.mockProjectDetails[groups[0]]) {
    send(404, { success: false, error: 'Project not found' });
    return true;
  }
  if (req.method === 'GET') {
    send(...route.run(shared, groups, null));
    return true;
  }
  shared.collectJson(req, res, (body) => send(...route.run(shared, groups, body)));
  return true;
}
