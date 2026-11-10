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
// filing one quote per persona that is found verbatim in the document.
// Wired into mock-server.js by handleDomainModules.

import { randomBytes } from 'node:crypto';

const DOC_PATH = /^\/projects\/([^/]+)\/documents\/([^/]+)\/(comments|share|persona-review)(?:\/([^/]+)(?:\/(replies|resolve|reopen))?)?$/;
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
    status: 'open', flagged: false, created_at: at, updated_at: at, author, replies: [], from_review_link: false, ...extra,
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

/** A thread as the reviewer sees it: no teammate's sub, no other address. */
const reviewerView = (thread) => ({
  ...thread,
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

function threadAction(key, commentId, action, body) {
  const thread = threadsOf(key).find((row) => row.comment_id === commentId);
  if (!thread) return bad(404, 'Comment not found');
  if (action === 'replies') {
    if (thread.replies.length >= MAX_REPLIES) return bad(409, 'This thread has reached its reply limit');
    const reply = { reply_id: randomBytes(6).toString('hex'), author: TEAM_AUTHOR, text: textOf(body, 'text'), flagged: false, at: nowIso() };
    return [200, { thread: replaceThread(key, { ...thread, replies: [...thread.replies, reply], updated_at: reply.at }) }];
  }
  return [200, { thread: replaceThread(key, { ...thread, status: action === 'resolve' ? 'resolved' : 'open', updated_at: nowIso() }) }];
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
      return [200, { series, document_id: doc.document_id, threads: threadsOf(key), share: share ? shareView(share) : null, can_edit: true }];
    }
    if (req.method === 'POST') return [200, { thread: addThread(key, newThread(doc, TEAM_AUTHOR, textOf(payload, 'text'), anchorOf(payload.anchor))) }];
    return bad(405, 'Method not allowed');
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
  const respond = (body) => send(...guarded(() => (documentMatch
    ? documentRoute(req, documentMatch, body, shared)
    : reviewRoute(req, reviewMatch, body, shared))));
  if (req.method === 'GET' || req.method === 'DELETE') respond(null);
  else shared.collectJson(req, res, respond);
  return true;
}
