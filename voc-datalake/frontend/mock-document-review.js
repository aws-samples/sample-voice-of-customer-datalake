// Document comments, review links, persona review and the review page (docs/document-review.md).
// Wire shapes follow lambda/shared/document_review_routes.py (+ document_comments.py,
// document_share.py, document_review.py): `{series, document_id, threads, share, can_edit}`,
// `{thread}`, `{share, created}`, `{success, revoked}`, and the review page's
// `{share, document, threads, viewer}`. Errors are `{success: false, error}` (400/404/409/429).
//
// Stateful for the life of the mock process. Threads are kept per document SERIES (type + base
// title, as the server keys them), so a comment made on one version shows on the next. The mock's
// one caller is the project's team AND, on /review, the reviewer `reviewer@example.com`.
// The persona review is an assist job of the project registry (shared.startProjectAssistJob),
// filing one quote per persona that is found verbatim in the document. So is "Revise from
// comments" (reviseRoute: recommendations, proposal or applied), and `…/comments/addressed` marks
// threads by the path's version, or clears them (`addressed: false`), appending to their history. proj_1's PRD and PR/FAQ start with a few threads (SEEDED_THREADS), seeded on the first
// request of this module.
// Wired into mock-server.js by handleDomainModules.

import { randomBytes } from 'node:crypto';

const DOC_PATH = /^\/projects\/([^/]+)\/documents\/([^/]+)\/(comments|share|persona-review|revise-from-comments)(?:\/([^/]+)(?:\/(replies|resolve|reopen))?)?$/;
const REVIEW_PATH = /^\/review\/([^/]+)(?:\/comments(?:\/([^/]+)\/replies)?)?$/;
const SHARE_ID = /^shr_[0-9a-f]{32}$/;
const COMMENTABLE = new Set(['prfaq', 'prd']);
const MAX_TEXT = 2000;
const MAX_EXACT = 500;
const MAX_REPLIES = 50;
const MAX_REVIEW_PERSONAS = 6;
const DAY_MS = 86_400_000;
const TEAM_AUTHOR = { kind: 'user', sub: 'sub-admin-demo', name: 'admin-demo' };
const REVIEWER = { email: 'reviewer@example.com', name: 'reviewer@example.com' };
const LINK_GONE = 'This review link has expired or was turned off';

const threadsBySeries = new Map(); // series key -> thread[]
const shares = new Map(); // share id -> share
const shareBySeries = new Map(); // series key -> share id

const bad = (status, error) => [status, { success: false, error }];
const nowIso = () => new Date().toISOString();
const newCommentId = () => `dc_${String(Date.now() * 1000).padStart(20, '0')}${randomBytes(3).toString('hex')}`;
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const baseTitle = (doc) => String(doc.base_title ?? doc.title ?? '').trim().replace(/\(v\d+\)$/i, '').trim().toLowerCase();
const seriesKey = (projectId, doc) => `${projectId}#${doc.document_type}#${baseTitle(doc)}`;
/** A document's series key (document_series.series_of), for a save naming its revise pass (mock-project-actions.js). */
export const documentSeriesKey = seriesKey;

// What a pass records about the AI that wrote it (document_revision: the `documents` surface's model,
// REVISE_PROMPT_VERSION): on its result (`model_id`, `prompt_version`) and, as
// `llm_metadata: {model, prompt_version}`, on the version it writes or a saved proposal.
const REVISE_MODEL = 'global.anthropic.claude-sonnet-5-5';
const REVISE_PROMPT_VERSION = '1.0.0';
// model_config.model_label for the mock's revise model; any other id has no label (shown as its id).
const MODEL_LABELS = new Map([[REVISE_MODEL, 'Claude Sonnet 5.5']]);
/** document_history._llm_metadata_view: a stored `llm_metadata` plus its model's label, or null. */
export function versionLlmView(llm) {
  if (!isObject(llm) || typeof llm.model !== 'string') return null;
  return { model: llm.model, prompt_version: llm.prompt_version ?? null, model_label: MODEL_LABELS.get(llm.model) ?? null };
}
const seriesId = (key) => `ser_${Buffer.from(key).toString('hex').slice(0, 24)}`;

function textOf(body, field, required = true) {
  const value = body[field];
  if (value === undefined || value === null) {
    if (required) throw new Error(`${field} is required`);
    return '';
  }
  if (typeof value !== 'string' || (required && value.trim() === '')) throw new Error(`${field} must be a string`);
  if (value.trim().length > MAX_TEXT) throw new Error(`${field} must be at most ${MAX_TEXT} characters`);
  return value.trim();
}

function anchorOf(raw) {
  if (raw === undefined || raw === null) return null;
  if (!isObject(raw) || typeof raw.exact !== 'string' || raw.exact.trim() === '' || raw.exact.length > MAX_EXACT) {
    throw new Error('anchor must be {exact, prefix?, suffix?, heading?}');
  }
  return { exact: raw.exact.trim(), prefix: String(raw.prefix ?? ''), suffix: String(raw.suffix ?? ''), heading: String(raw.heading ?? '') };
}

function newThread(doc, author, text, anchor, extra = {}) {
  const at = nowIso();
  return {
    comment_id: newCommentId(), document_id: doc.document_id, version: doc.version ?? 1, text, anchor,
    status: 'open', flagged: false, created_at: at, updated_at: at, author, replies: [], from_review_link: false, addressed: null, ...extra,
  };
}

const threadsOf = (key) => threadsBySeries.get(key) ?? [];

function addThread(key, thread) {
  threadsBySeries.set(key, [...threadsOf(key), thread]);
  return thread;
}

function replaceThread(key, thread) {
  threadsBySeries.set(key, threadsOf(key).map((row) => (row.comment_id === thread.comment_id ? thread : row)));
  return thread;
}

/** A thread as the API answers it (the addressed history stays server-side). */
function threadView(thread) {
  const view = { ...thread };
  delete view.addressed_history;
  return view;
}

/** A thread as the reviewer sees it: no teammate's sub, no other address. */
const reviewerView = (thread) => ({
  ...threadView(thread),
  author: { kind: thread.author.kind, name: thread.author.name },
  replies: thread.replies.map((reply) => ({ ...reply, author: { kind: reply.author.kind, name: reply.author.name } })),
});

function activeShare(key) {
  const share = shares.get(shareBySeries.get(key));
  return share && !share.revoked && Date.parse(share.expires_at) > Date.now() ? share : null;
}

const shareView = (share) => ({ ...share, path: `/review/${share.share_id}`, active: !share.revoked });

function audienceOf(raw) {
  if (raw === undefined || raw === null) return { mode: 'anyone', domains: [], emails: [] };
  if (!isObject(raw) || !['anyone', 'list'].includes(raw.mode)) throw new Error('audience must be {mode: anyone|list, domains?, emails?}');
  const domains = Array.isArray(raw.domains) ? raw.domains.filter((d) => typeof d === 'string') : [];
  const emails = Array.isArray(raw.emails) ? raw.emails.filter((e) => typeof e === 'string') : [];
  if (raw.mode === 'list' && domains.length === 0 && emails.length === 0) throw new Error('A list audience needs at least one domain or email address');
  return { mode: raw.mode, domains, emails };
}

function createShare(projectId, doc, key, body) {
  const existing = activeShare(key);
  if (existing) return [200, { share: shareView(existing), created: false }];
  const days = body.expires_in_days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) throw new Error('expires_in_days must be a whole number from 1 to 90');
  const share = {
    share_id: `shr_${randomBytes(16).toString('hex')}`, project_id: projectId, series_key: key,
    series_id: seriesId(key), document_type: doc.document_type, base_title: doc.base_title ?? doc.title,
    audience: audienceOf(body.audience), revoked: false, created_at: nowIso(), created_by_name: TEAM_AUTHOR.name,
    expires_at: new Date(Date.now() + days * DAY_MS).toISOString(),
  };
  shares.set(share.share_id, share);
  shareBySeries.set(key, share.share_id);
  return [200, { share: shareView(share), created: true }];
}

/** Persona review: one quote per persona (the document's first sentence long enough), plus a verdict. */
function personaReview(detail, doc, key) {
  const sentences = String(doc.content ?? '').replace(/[#*_`>|-]/g, ' ').split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/\s+/g, ' ').trim()).filter((s) => s.length >= 20);
  const personas = (detail.personas ?? []).slice(0, MAX_REVIEW_PERSONAS);
  if (personas.length === 0) return bad(400, 'This project has no personas to ask yet');
  const results = personas.map((persona, index) => {
    const author = { kind: 'persona', persona_id: persona.persona_id, name: persona.name };
    const quote = sentences[index % Math.max(1, sentences.length)];
    addThread(key, newThread(doc, author, `As ${persona.name}, this reads clearly, but it does not say what happens when it goes wrong.`, null, { verdict: 'mixed' }));
    if (quote !== undefined) {
      addThread(key, newThread(doc, author, 'This is the part I would want proof of before I believe it.', { exact: quote, prefix: '', suffix: '', heading: '' }));
    }
    return { persona_id: persona.persona_id, name: persona.name, ok: true, stance: 'mixed', filed: quote === undefined ? 1 : 2, dropped: 0 };
  });
  return [200, { document_id: doc.document_id, version: doc.version ?? 1, personas: results, filed: results.reduce((n, r) => n + r.filed, 0) }];
}

// ── Revise from comments (lambda/shared/document_revision.py) ──────────────────────────────
// The outcome follows the caller's way of working: MOCK_REVISE_OUTCOME=recommendations|proposal|applied
// picks one; else the mock caller's mode when the server hands it over (shared.aiModeOf), else
// "proposal". A thread's change is a canned rewrite of its quote when the quote occurs exactly once
// in the version's Markdown (REWRITES, the seeded threads' quotes), so every `before` is verbatim.
const REVISE_OUTCOMES = ['recommendations', 'proposal', 'applied'];
const MAX_REVISE_THREADS = 50;
const COMMENT_ID = /^dc_\d{20}[0-9a-f]{6}$/;
const REWRITES = new Map([
  ["Quiet hours are 21:00 to 08:00 in the customer's time zone",
    "Quiet hours are 21:00 to 08:00 in the customer's time zone, except for an order the customer marked as urgent"],
  ['Tell the customer about a delay within minutes of the carrier event',
    'Tell the customer about a delay within minutes of the carrier event (a late carrier event is covered in 4.3)'],
  ['at most once a day unless it moves again', 'at most once a day per parcel, even if it moves again'],
  ['Delivery contacts per 1,000 orders', 'Delivery contacts per 1,000 orders (support report, last quarter)'],
]);

function reviseOutcome(shared) {
  const forced = process.env.MOCK_REVISE_OUTCOME;
  if (REVISE_OUTCOMES.includes(forced)) return forced;
  const mode = typeof shared.aiModeOf === 'function' ? shared.aiModeOf(shared.mockCaller?.username)?.mode : null;
  if (mode === 'ai_driven') return 'applied';
  return mode === 'human_driven' ? 'recommendations' : 'proposal';
}

function threadIdsOf(raw, required) {
  if (raw === undefined && !required) return null;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_REVISE_THREADS || !raw.every((id) => COMMENT_ID.test(id))) {
    throw new Error(`thread_ids must be a list of 1 to ${MAX_REVISE_THREADS} comment ids`);
  }
  return [...new Set(raw)];
}

const placedIn = (content) => (thread) => thread.anchor === null || content.includes(thread.anchor.exact);
const answered = (thread) => thread.status === 'resolved' || thread.replies.length > 0;

function revisableThreads(key, doc, wanted) {
  const content = String(doc.content ?? '');
  const chosen = wanted === null
    ? threadsOf(key).filter((t) => answered(t) && !t.addressed)
    : threadsOf(key).filter((t) => wanted.includes(t.comment_id));
  return chosen.filter(placedIn(content)).slice(0, MAX_REVISE_THREADS);
}

function proposedChanges(threads, content) {
  return threads.flatMap((thread) => {
    const before = thread.anchor?.exact;
    const after = before === undefined ? undefined : REWRITES.get(before);
    if (after === undefined || content.split(before).length !== 2) return [];
    return [{ thread_ids: [thread.comment_id], before, after, reason: `Answers: "${thread.text.slice(0, 80)}"` }];
  }).map((change, index) => ({ change_id: `ch_${index + 1}`, ...change }));
}

// document_comments.MAX_ADDRESSED_HISTORY: append-only (D1), one more is a 409, like replies past 50.
const MAX_ADDRESSED_HISTORY = 100;
const ADDRESSED_FULL = 'This comment has reached its limit of addressed marks; start a new comment';
const ADDRESSED_SOME_FULL = 'Some comments have reached their limit of addressed marks and were not marked; '
  + 'the others were. Start a new comment for those';

/** Append `entry` to each thread of `ids`, in order: `{marked, full}`. A full thread does not stop the others
 * (record_threads_addressed tries every thread; the route then answers its 409, the applied pass skips it). */
function appendAddressed(key, ids, entry) {
  const marked = [];
  let full = false;
  for (const thread of threadsOf(key).filter((t) => ids.includes(t.comment_id))) {
    if ((thread.addressed_history ?? []).length >= MAX_ADDRESSED_HISTORY) {
      full = true;
      continue;
    }
    marked.push(replaceThread(key, {
      ...thread, updated_at: entry.at,
      addressed_history: [...(thread.addressed_history ?? []), entry],
      addressed: entry.addressed ? { version: entry.version, at: entry.at, by_kind: entry.by_kind } : null,
    }));
  }
  return { marked, full };
}

/** The route's 409 when a thread's history is full; "some marked" has its machine-readable `code` (ApiError.code). */
function fullAnswer(marked) {
  return marked.length === 0
    ? [409, { success: false, error: ADDRESSED_FULL }]
    : [409, { success: false, error: ADDRESSED_SOME_FULL, code: 'addressed_some_full' }];
}

function addressedEntry(doc, byKind, addressed) {
  return { version: doc.version ?? 1, document_id: doc.document_id, at: nowIso(), by_kind: byKind, addressed };
}

/** `{thread_ids, addressed?: boolean = true}`: `doc` (the path's version) marks or clears the threads.
 * Each call is appended to the thread's `addressed_history` (D1); `addressed` is the newest mark, else null. */
function recordAddressed(key, doc, body, byKind) {
  if (Object.keys(body).some((field) => field !== 'thread_ids' && field !== 'addressed')) throw new Error('body must be {thread_ids, addressed?}');
  const addressed = body.addressed ?? true;
  if (typeof addressed !== 'boolean') throw new Error('addressed must be true or false');
  const ids = threadIdsOf(body.thread_ids, true);
  if (!threadsOf(key).some((t) => ids.includes(t.comment_id))) return bad(404, 'Comment not found');
  const { marked, full } = appendAddressed(key, ids, addressedEntry(doc, byKind, addressed));
  return full ? fullAnswer(marked) : [200, { threads: marked.map(threadView) }];
}

/** The applied revision: the next version of the series (D1), its threads addressed by the AI. */
function applyRevision({ detail, doc, key }, changes, shared) {
  const base = String(doc.base_title ?? doc.title ?? '').trim().replace(/\(v\d+\)$/i, '').trim();
  const series = detail.documents.filter((d) => seriesKey('', d) === seriesKey('', doc));
  const version = Math.max(...series.map((d) => d.version ?? 1)) + 1;
  const content = changes.reduce((text, change) => text.replace(change.before, change.after), String(doc.content ?? ''));
  // The row's own identity is never carried (document_history._ROW_IDENTITY_FIELDS): a saved pass's id stays on its version.
  const carried = { ...doc };
  delete carried.revise_job_id;
  delete carried.llm_metadata;
  const revised = {
    ...carried, document_id: shared.nextMockId(doc.document_type), title: `${base} (v${version})`, base_title: base, version,
    content, created_at: nowIso(), updated_at: nowIso(), edit_kind: 'revise', edited_from_id: doc.document_id,
    edited_by: { sub: shared.mockCaller?.sub ?? '', kind: 'user' },
    llm_metadata: { model: REVISE_MODEL, prompt_version: REVISE_PROMPT_VERSION },
  };
  detail.documents.push(revised);
  const answeredIds = [...new Set(changes.flatMap((change) => change.thread_ids))];
  // The version is written: a thread that cannot be marked is left out, never a failed pass.
  const { marked } = appendAddressed(key, answeredIds, addressedEntry(revised, 'ai', true));
  return {
    applied_version: { document_id: revised.document_id, version },
    addressed_thread_ids: marked.map((thread) => thread.comment_id),
  };
}

function reviseRoute(ctx, body, shared) {
  if (Object.keys(body).some((field) => field !== 'thread_ids')) return bad(400, 'body must be {thread_ids?}');
  const threads = revisableThreads(ctx.key, ctx.doc, threadIdsOf(body.thread_ids, false));
  if (threads.length === 0) return bad(400, 'No comments to revise from yet: reply to a comment or resolve it first');
  const outcome = reviseOutcome(shared);
  const recommendations = threads.map((thread) => ({
    thread_id: thread.comment_id,
    text: REWRITES.has(thread.anchor?.exact)
      ? `Reword "${thread.anchor.exact}" so it answers this comment, and keep the evidence it cites.`
      : 'No change needed in the text: reply to the comment to close it.',
  }));
  const changes = outcome === 'recommendations' ? [] : proposedChanges(threads, String(ctx.doc.content ?? ''));
  const result = {
    outcome, base_document_id: ctx.doc.document_id, base_version: ctx.doc.version ?? 1, recommendations, changes,
    applied_version: null, addressed_thread_ids: [], dropped: 0,
    model_id: REVISE_MODEL, prompt_version: REVISE_PROMPT_VERSION,
  };
  const answer = outcome === 'applied' && changes.length > 0 ? { ...result, ...applyRevision(ctx, changes, shared) }
    : { ...result, outcome: outcome === 'applied' ? 'recommendations' : outcome };
  // The job keeps the series the pass read (its config's series_id): a save of the proposal is checked against it.
  return shared.startProjectAssistJob(ctx.projectId, 'assist_revise_from_comments', [200, answer], { series_key: ctx.key });
}

function threadAction(key, commentId, action, body) {
  const thread = threadsOf(key).find((row) => row.comment_id === commentId);
  if (!thread) return bad(404, 'Comment not found');
  if (action === 'replies') {
    if (thread.replies.length >= MAX_REPLIES) return bad(409, 'This thread has reached its reply limit');
    const reply = { reply_id: randomBytes(6).toString('hex'), author: TEAM_AUTHOR, text: textOf(body, 'text'), flagged: false, at: nowIso() };
    return [200, { thread: threadView(replaceThread(key, { ...thread, replies: [...thread.replies, reply], updated_at: reply.at })) }];
  }
  return [200, { thread: threadView(replaceThread(key, { ...thread, status: action === 'resolve' ? 'resolved' : 'open', updated_at: nowIso() })) }];
}

function shareRoute(req, projectId, doc, key, body) {
  if (req.method === 'POST') return createShare(projectId, doc, key, isObject(body) ? body : {});
  const share = activeShare(key);
  if (req.method === 'DELETE') {
    if (share) share.revoked = true;
    shareBySeries.delete(key);
    return [200, { success: true, revoked: share !== null }];
  }
  if (req.method === 'GET') return [200, { share: share ? shareView(share) : null }];
  return bad(405, 'Method not allowed');
}

function commentsRoute(req, { doc, key, series, commentId, action }, body) {
  const payload = body ?? {};
  if (commentId === undefined) {
    if (req.method === 'GET') {
      const share = activeShare(key);
      return [200, { series, document_id: doc.document_id, threads: threadsOf(key).map(threadView), share: share ? shareView(share) : null, can_edit: true }];
    }
    if (req.method === 'POST') return [200, { thread: addThread(key, newThread(doc, TEAM_AUTHOR, textOf(payload, 'text'), anchorOf(payload.anchor))) }];
    return bad(405, 'Method not allowed');
  }
  if (commentId === 'addressed') {
    return req.method === 'POST' ? recordAddressed(key, doc, payload, 'user') : bad(405, 'Method not allowed');
  }
  if (req.method === 'DELETE' && action === undefined) {
    threadsBySeries.set(key, threadsOf(key).filter((row) => row.comment_id !== commentId));
    return [200, { success: true, comment_id: commentId }];
  }
  if (req.method === 'POST' && action !== undefined) return threadAction(key, commentId, action, payload);
  return bad(405, 'Method not allowed');
}

function documentRoute(req, match, body, shared) {
  const [, projectId, documentId, kind, commentId, action] = match;
  const detail = shared.mockProjectDetails[projectId];
  const doc = detail?.documents?.find((row) => row.document_id === documentId);
  if (!doc) return bad(404, 'Document not found');
  if (!COMMENTABLE.has(doc.document_type)) return bad(400, 'Comments are available on PR/FAQ and PRD documents only');
  const key = seriesKey(projectId, doc);
  if (kind === 'persona-review') {
    return req.method === 'POST'
      ? shared.startProjectAssistJob(projectId, 'assist_persona_review', personaReview(detail, doc, key))
      : bad(405, 'Method not allowed');
  }
  if (kind === 'revise-from-comments') {
    return req.method === 'POST'
      ? reviseRoute({ detail, doc, key, projectId }, body ?? {}, shared)
      : bad(405, 'Method not allowed');
  }
  if (kind === 'share') return shareRoute(req, projectId, doc, key, body);
  const series = { series_id: seriesId(key), document_type: doc.document_type, base_title: doc.base_title ?? doc.title };
  return commentsRoute(req, { doc, key, series, commentId, action }, body);
}

/** The newest version of the shared series in the mock store. */
function latestVersion(shared, share) {
  const documents = shared.mockProjectDetails[share.project_id]?.documents ?? [];
  return documents.filter((doc) => seriesKey(share.project_id, doc) === share.series_key)
    .sort((a, b) => (b.version ?? 1) - (a.version ?? 1))[0];
}

function reviewRoute(req, match, body, shared) {
  const [, shareId, commentId] = match;
  const share = SHARE_ID.test(shareId) ? shares.get(shareId) : undefined;
  if (!share || share.revoked || Date.parse(share.expires_at) <= Date.now()) return bad(404, LINK_GONE);
  const doc = latestVersion(shared, share);
  if (!doc) return bad(404, LINK_GONE);
  const key = share.series_key;
  const own = (thread) => thread.author.kind === 'reviewer' && thread.author.email === REVIEWER.email;
  const author = { kind: 'reviewer', email: REVIEWER.email, name: REVIEWER.name };
  if (req.method === 'GET' && commentId === undefined) {
    return [200, {
      share: { share_id: shareId, document_type: share.document_type, expires_at: share.expires_at },
      document: { document_id: doc.document_id, version: doc.version ?? 1, title: doc.title, content: doc.content ?? '' },
      threads: threadsOf(key).filter(own).map(reviewerView), viewer: { email: REVIEWER.email, name: '' },
    }];
  }
  if (req.method !== 'POST') return bad(405, 'Method not allowed');
  if (commentId === undefined) {
    const thread = addThread(key, newThread(doc, author, textOf(body ?? {}, 'text'), anchorOf(body?.anchor), { from_review_link: true }));
    return [200, { thread: reviewerView(thread) }];
  }
  const thread = threadsOf(key).find((row) => row.comment_id === commentId && own(row));
  if (!thread) return bad(404, 'Comment not found');
  const reply = { reply_id: randomBytes(6).toString('hex'), author, text: textOf(body ?? {}, 'text'), flagged: false, at: nowIso() };
  return [200, { thread: reviewerView(replaceThread(key, { ...thread, replies: [...thread.replies, reply] })) }];
}

// ── Seeded threads (the document canvas's demo, proj_1's PRD and PR/FAQ series) ─────────────
// Each anchor's `exact` is text of the series head in mock-server.js, so the canvas finds it.
const TEAMMATE = { kind: 'user', sub: 'sub-viewer-demo', name: 'viewer-demo' };
const DANA = { kind: 'persona', persona_id: 'persona_1', name: 'Deadline-Driven Dana' };
const VICTOR = { kind: 'persona', persona_id: 'persona_2', name: 'Value-Hunter Victor' };
const anchored = (exact, heading) => ({ exact, prefix: '', suffix: '', heading });
const SEEDED_THREADS = [
  { projectId: 'proj_1', documentId: 'prd_1', threads: [
    { author: DANA, version: 3, daysOld: 1, anchor: anchored("Quiet hours are 21:00 to 08:00 in the customer's time zone", '4.2 Message rules'),
      text: 'My trips start at 07:00. A message at 08:00 is too late: let me turn quiet hours off for an order I marked as urgent.',
      replies: [{ author: TEAM_AUTHOR, daysOld: 0.5, text: 'Good point. Adding an "urgent order" exception to 4.2 in the next version.' }] },
    { author: TEAMMATE, version: 2, daysOld: 3, status: 'resolved', anchor: anchored('Tell the customer about a delay within minutes of the carrier event', '3.1 Goals'),
      text: 'Five minutes is not something we can promise when the carrier event itself is late.',
      replies: [{ author: TEAM_AUTHOR, daysOld: 2, text: 'Changed to "within minutes", and the warning in 4.3 says what happens for late events.' }] },
    { author: TEAMMATE, version: 3, daysOld: 0.2, anchor: null,
      text: 'Ready for the leadership review on Thursday once the quiet-hours question is settled.', replies: [] },
  ] },
  { projectId: 'proj_1', documentId: 'prfaq_1', threads: [
    { author: VICTOR, version: 3, daysOld: 1, anchor: anchored('at most once a day unless it moves again', 'Customer FAQ'),
      text: 'Once a day is fine. If you message me twice about the same parcel, I turn the messages off.',
      replies: [{ author: TEAM_AUTHOR, daysOld: 0.6, text: 'Fair. We will say "once a day per parcel" in the FAQ.' }] },
    // A persona review's verdict is that persona's comment on the whole document (shared/document_review.py).
    { author: VICTOR, version: 3, daysOld: 1, anchor: null, verdict: 'positive',
      text: 'Clear and honest. I would trust these messages, as long as there are not too many of them.', replies: [] },
    { author: TEAMMATE, version: 3, daysOld: 0.5, anchor: anchored('Delivery contacts per 1,000 orders', 'Internal FAQ'),
      text: 'Where does the 42 come from? Please link the support report.',
      replies: [{ author: TEAM_AUTHOR, daysOld: 0.3, text: 'It is last quarter\'s support report; naming it in the table.' }] },
  ] },
];
const ago = (days) => new Date(Date.now() - days * DAY_MS).toISOString();
let seeded = false;

function seedThreads(shared) {
  if (seeded) return;
  seeded = true;
  for (const { projectId, documentId, threads } of SEEDED_THREADS) {
    const doc = shared.mockProjectDetails[projectId]?.documents?.find((row) => row.document_id === documentId);
    if (!doc) continue;
    const key = seriesKey(projectId, doc);
    for (const { author, version, daysOld, status = 'open', anchor, text, verdict, replies } of threads) {
      const at = ago(daysOld);
      const versionDoc = shared.mockProjectDetails[projectId].documents
        .find((row) => seriesKey(projectId, row) === key && (row.version ?? 1) === version) ?? doc;
      addThread(key, {
        ...newThread(versionDoc, author, text, anchor, verdict ? { verdict } : {}),
        status, created_at: at, updated_at: replies.length > 0 ? ago(replies.at(-1).daysOld) : at,
        ...(status === 'resolved' ? { status_by: TEAM_AUTHOR.sub } : {}),
        replies: replies.map((reply) => ({
          reply_id: randomBytes(6).toString('hex'), author: reply.author, text: reply.text, flagged: false, at: ago(reply.daysOld),
        })),
      });
    }
  }
}

function guarded(route) {
  try {
    return route();
  } catch (error) {
    return bad(400, error instanceof Error ? error.message : 'Invalid request');
  }
}

export function handleDocumentReviewRoutes(req, res, url, send, shared) {
  const documentMatch = url.pathname.match(DOC_PATH);
  const reviewMatch = documentMatch ? null : url.pathname.match(REVIEW_PATH);
  if (!documentMatch && !reviewMatch) return false;
  seedThreads(shared);
  const respond = (body) => send(...guarded(() => (documentMatch
    ? documentRoute(req, documentMatch, body, shared)
    : reviewRoute(req, reviewMatch, body, shared))));
  if (req.method === 'GET' || req.method === 'DELETE') respond(null);
  else shared.collectJson(req, res, respond);
  return true;
}
