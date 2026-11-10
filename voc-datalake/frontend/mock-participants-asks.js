// Participants mock — asks for feedback (docs/participants.md): POST/GET /participants/asks,
// GET /participants/asks/{ask_id}. Same status codes as the engagement API: 409
// email_not_configured, 400 no_recipients / too_many_recipients / bad fields, 429 daily_cap.
// A new ask is "sent" at once (the mock has no async continuation).

import { newId, now, state } from './mock-participants-data.js';

const MAX_RECIPIENTS = 500;
const MAX_SUBJECT = 160;
const MAX_MESSAGE = 4000;

const fail = (status, error) => [status, { success: false, error }];
const isActive = (personId) => state.people.get(personId)?.status === 'active';

function recipientIds(body) {
  const ids = new Set(Array.isArray(body.person_ids) ? body.person_ids.filter((id) => state.people.has(id)) : []);
  for (const listId of Array.isArray(body.list_ids) ? body.list_ids : []) {
    for (const personId of state.members.get(listId) ?? []) ids.add(personId);
  }
  return [...ids];
}

function linkOf(body) {
  const link = body.link ?? {};
  if (link.kind === 'form' && typeof link.form_id === 'string' && link.form_id !== '') {
    return { kind: 'form', form_id: link.form_id, url: `https://api.example.com/v1/feedback-forms/${link.form_id}/iframe` };
  }
  if (link.kind === 'url' && typeof link.url === 'string' && link.url.startsWith('https://')) return { kind: 'url', url: link.url };
  return null;
}

function textProblem(body) {
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (subject === '' || subject.length > MAX_SUBJECT) return 'subject must be 1-160 characters';
  if (message === '' || message.length > MAX_MESSAGE) return 'message must be 1-4000 characters';
  return null;
}

/** The refusal for a request, or null when it may be sent. */
function refusal(body, ids) {
  if (!state.emailEnabled) return fail(409, 'email_not_configured');
  const problem = textProblem(body);
  if (problem !== null) return fail(400, problem);
  if (linkOf(body) === null) return fail(400, 'link must be a feedback form or an https URL');
  // Like the API: the size limit counts every recipient, emptiness and the cap only the ACTIVE ones.
  if (ids.length > MAX_RECIPIENTS) return fail(400, 'too_many_recipients');
  const active = ids.filter(isActive).length;
  if (active === 0) return fail(400, 'no_recipients');
  if (state.sentToday + active > state.settings.daily_send_cap) return fail(429, 'daily_cap');
  return null;
}

function recipientRow(personId) {
  const skipped = state.people.get(personId)?.status === 'unsubscribed';
  return { person_id: personId, status: skipped ? 'skipped_unsubscribed' : 'sent', sent_at: skipped ? null : now(), responded_at: null, error: null };
}

function createAsk(body) {
  const ids = recipientIds(body);
  const refused = refusal(body, ids);
  if (refused !== null) return refused;
  const link = linkOf(body);
  const rows = ids.map(recipientRow);
  const skipped = rows.filter((row) => row.status === 'skipped_unsubscribed').length;
  const ask = {
    ask_id: newId('ask_'), project_id: typeof body.project_id === 'string' ? body.project_id : null,
    subject: body.subject.trim(), message: body.message.trim(), link,
    counts: { recipients: rows.length, sent: rows.length - skipped, failed: 0, skipped, responded: 0 },
    status: 'sent', created_by: 'mock-admin', created_at: now(),
  };
  state.asks.set(ask.ask_id, ask);
  state.recipients.set(ask.ask_id, rows);
  state.sentToday += rows.length - skipped;
  return [202, { ask }];
}

function listAsks(url) {
  const projectId = url.searchParams.get('project_id');
  const asks = [...state.asks.values()]
    .filter((ask) => projectId === null || ask.project_id === projectId)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return [200, { asks }];
}

function askDetail(askId) {
  const ask = state.asks.get(askId);
  if (!ask) return fail(404, 'Ask not found');
  const recipients = (state.recipients.get(askId) ?? []).map((row) => {
    const person = state.people.get(row.person_id);
    return { ...row, email: person?.email ?? null, name: person ? person.name || null : null };
  });
  return [200, { ask, recipients }];
}

/** The asks routes, or null when the path is not one of them. */
export function askRoute(req, url, body) {
  if (url.pathname === '/participants/asks') {
    if (req.method === 'POST') return createAsk(body ?? {});
    if (req.method === 'GET') return listAsks(url);
    return fail(405, 'Method not allowed');
  }
  const match = url.pathname.match(/^\/participants\/asks\/([^/]+)$/u);
  if (!match) return null;
  return req.method === 'GET' ? askDetail(decodeURIComponent(match[1])) : fail(405, 'Method not allowed');
}
