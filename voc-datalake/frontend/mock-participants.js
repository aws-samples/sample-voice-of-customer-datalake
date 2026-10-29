// Participants mock (docs/participants.md): /participants/*, POST /unsubscribe, in the
// lambda/api/engagement_handler.py wire shape (`{success: false, error}` on 4xx, as shared/api.py answers). Stateful for the
// life of the mock process; state in mock-participants-data.js, asks in mock-participants-asks.js.
// Wired into mock-server.js by handleDomainModules.

import { askRoute } from './mock-participants-asks.js';
import { newId, now, personView, state, syncMemberCounts } from './mock-participants-data.js';

const KINDS = ['employees', 'paid', 'beta', 'sales', 'customers', 'requesters', 'custom'];
const MAX_PEOPLE_PER_ADD = 200;
const MAX_DAILY_CAP = 5000;
const EMAIL = /^[^\s@]+@[a-z0-9.-]+\.[a-z]{2,}$/iu;

const fail = (status, error) => [status, { success: false, error }];
const SETTINGS_FIELDS = ['company_domains', 'allow_external_people', 'daily_send_cap', 'sender_name'];
const MAX_PEOPLE_LISTED = 500;
const text = (value) => (typeof value === 'string' ? value.trim() : '');

function settingsView() {
  return {
    settings: state.settings, email_enabled: state.emailEnabled, board_enabled: true,
    board_url: 'https://voc.example.com/board',
  };
}

/** Why a settings body is refused (participants_settings.validate_changes), or null. Partial: only named fields change. */
function settingsProblem(body) {
  const unknown = Object.keys(body).filter((key) => !SETTINGS_FIELDS.includes(key)).sort();
  if (unknown.length > 0) return `unknown settings field: ${unknown[0]}`;
  if ('company_domains' in body && (!Array.isArray(body.company_domains) || body.company_domains.length > 20)) {
    return 'company_domains must be a list of at most 20 domains';
  }
  if ('allow_external_people' in body && typeof body.allow_external_people !== 'boolean') return 'allow_external_people must be true or false';
  const cap = body.daily_send_cap;
  if ('daily_send_cap' in body && (!Number.isInteger(cap) || cap < 1 || cap > MAX_DAILY_CAP)) return 'daily_send_cap must be a whole number from 1 to 5000';
  if ('sender_name' in body && (text(body.sender_name) === '' || text(body.sender_name).length > 80)) return 'sender_name must be 1-80 characters';
  return null;
}

function putSettings(body) {
  const problem = settingsProblem(body);
  if (problem !== null) return fail(400, problem);
  const changes = { ...body };
  if (Array.isArray(body.company_domains)) changes.company_domains = [...new Set(body.company_domains.map((d) => text(d).toLowerCase().replace(/^@/u, '')).filter(Boolean))];
  if ('sender_name' in body) changes.sender_name = text(body.sender_name);
  state.settings = { ...state.settings, ...changes, updated_at: now(), updated_by: 'mock-admin' };
  return [200, { settings: state.settings }];
}

/** Why a new address cannot become a person, or null. */
function newPersonProblem(email) {
  if (!EMAIL.test(email)) return 'invalid_email';
  const domain = email.split('@')[1].toLowerCase();
  if (!state.settings.allow_external_people && !state.settings.company_domains.includes(domain)) return 'external_not_allowed';
  return null;
}

const findByEmail = (email) => [...state.people.values()].find((p) => p.email_lc === email.toLowerCase());

function createPersonRow(input, origin = 'manual') {
  const email = text(input.email);
  const row = {
    person_id: newId('per_'), email, email_lc: email.toLowerCase(), name: text(input.name), company: text(input.company),
    title: text(input.title), notes: text(input.notes), tags: Array.isArray(input.tags) ? input.tags.map(text).filter(Boolean) : [],
    status: 'active', unsubscribed_at: null, origin, created_at: now(), created_by: 'mock-admin', updated_at: now(),
  };
  state.people.set(row.person_id, row);
  return row;
}

/** Existing or new person for an address: `{row}` or `{reason}`. */
function upsertPerson(input, origin = 'manual') {
  const existing = findByEmail(text(input.email));
  if (existing) return { row: existing, created: false };
  const reason = newPersonProblem(text(input.email));
  return reason === null ? { row: createPersonRow(input, origin), created: true } : { reason };
}

/** The origins a client may claim (participants_intake.CLIENT_ORIGINS); feature_request is the board's own. */
const CLIENT_ORIGINS = ['manual', 'assistant'];

function addMembers(listId, body) {
  const members = state.members.get(listId);
  const ids = Array.isArray(body.person_ids) ? body.person_ids : [];
  const people = Array.isArray(body.people) ? body.people : [];
  if (ids.length + people.length > MAX_PEOPLE_PER_ADD) return fail(400, 'at most 200 people per call');
  const origin = body.origin ?? 'manual';
  if (!CLIENT_ORIGINS.includes(origin)) return fail(400, 'origin must be one of: manual, assistant');
  const result = { added: 0, already: 0, created: 0, rejected: [] };
  const add = (personId) => {
    if (members.has(personId)) result.already += 1;
    else { members.add(personId); result.added += 1; }
  };
  ids.filter((id) => state.people.has(id)).forEach(add);
  for (const input of people) {
    const outcome = upsertPerson(input, origin);
    if (outcome.reason) { result.rejected.push({ email: text(input.email), reason: outcome.reason }); continue; }
    if (outcome.created) result.created += 1;
    add(outcome.row.person_id);
  }
  syncMemberCounts();
  return [200, result];
}

function saveList(body, existing) {
  if (existing && !['name', 'description', 'kind'].some((field) => field in body)) {
    return fail(400, 'Nothing to update: send name, description or kind');
  }
  const name = body.name === undefined && existing ? existing.name : text(body.name);
  const kind = body.kind ?? existing?.kind ?? 'custom';
  if (name === '' || name.length > 120) return fail(400, 'name must be 1-120 characters');
  if (!KINDS.includes(kind)) return fail(400, 'unknown kind');
  const row = existing ?? {
    list_id: newId('lst_'), member_count: 0, created_by: 'mock-admin', created_at: now(), feature_request_id: null,
  };
  Object.assign(row, { name, kind, description: body.description === undefined ? row.description ?? '' : text(body.description), updated_at: now() });
  state.lists.set(row.list_id, row);
  if (!state.members.has(row.list_id)) state.members.set(row.list_id, new Set());
  return [existing ? 200 : 201, { list: row }];
}

/** The list, its memberships and its project links; people stay (participants_lists.delete_list). */
function deleteList(listId) {
  state.lists.delete(listId);
  state.members.delete(listId);
  for (const link of state.projects.values()) link.lists.delete(listId);
  return [200, { success: true }];
}

function listRoute(req, listId, rest, body) {
  const row = state.lists.get(listId);
  if (!row) return fail(404, 'List not found');
  if (rest === undefined) {
    if (req.method === 'GET') return [200, { list: row, members: [...state.members.get(listId)].map((id) => personView(state.people.get(id))) }];
    if (req.method === 'PUT') return saveList(body, row);
    if (req.method === 'DELETE') return deleteList(listId);
    return fail(405, 'Method not allowed');
  }
  if (rest === 'members' && req.method === 'POST') return addMembers(listId, body);
  const member = rest.match(/^members\/([^/]+)$/u);
  if (member && req.method === 'DELETE') {
    state.members.get(listId).delete(decodeURIComponent(member[1]));
    syncMemberCounts();
    return [200, { success: true }];
  }
  return fail(405, 'Method not allowed');
}

function listPeople(url) {
  const q = (url.searchParams.get('q') ?? '').toLowerCase();
  const listId = url.searchParams.get('list_id');
  if (listId && !state.lists.has(listId)) return fail(404, 'List not found');
  const people = [...state.people.values()]
    .filter((p) => q === '' || [p.email, p.name, p.company].some((v) => v.toLowerCase().includes(q)))
    .filter((p) => !listId || state.members.get(listId)?.has(p.person_id))
    .slice(0, MAX_PEOPLE_LISTED)
    .map(personView);
  return [200, { people }];
}

function personAsks(personId) {
  return [...state.recipients].flatMap(([askId, rows]) => rows.filter((r) => r.person_id === personId).map((r) => ({
    ask_id: askId, subject: state.asks.get(askId)?.subject ?? '', status: r.status, sent_at: r.sent_at, responded_at: r.responded_at,
  })));
}

function erasePerson(personId) {
  state.people.delete(personId);
  for (const ids of state.members.values()) ids.delete(personId);
  for (const link of state.projects.values()) link.people.delete(personId);
  syncMemberCounts();
  return [200, { success: true }];
}

function personRoute(req, personId, body) {
  const row = state.people.get(personId);
  if (!row) return fail(404, 'Person not found');
  if (req.method === 'GET') {
    const lists = [...state.members].filter(([, ids]) => ids.has(personId)).map(([listId]) => state.lists.get(listId)).filter(Boolean);
    return [200, { person: personView(row), lists, asks: personAsks(personId) }];
  }
  if (req.method === 'PUT') {
    if ('email' in body) return fail(400, 'email cannot be changed: add the new address as a new person');
    if (!['name', 'company', 'title', 'notes', 'tags'].some((field) => field in body)) {
      return fail(400, 'Nothing to update: send name, company, title, notes or tags');
    }
    for (const field of ['name', 'company', 'title', 'notes']) if (body[field] !== undefined) row[field] = text(body[field]);
    if (Array.isArray(body.tags)) row.tags = body.tags.map(text).filter(Boolean);
    row.updated_at = now();
    return [200, { person: personView(row) }];
  }
  return req.method === 'DELETE' ? erasePerson(personId) : fail(405, 'Method not allowed');
}

function projectView(projectId) {
  const link = state.projects.get(projectId) ?? { lists: new Set(), people: new Set() };
  const reach = new Set([...link.people, ...[...link.lists].flatMap((id) => [...(state.members.get(id) ?? [])])]);
  const active = [...reach].filter((id) => state.people.get(id)?.status === 'active');
  return {
    lists: [...link.lists].map((id) => state.lists.get(id)).filter(Boolean),
    people: [...link.people].map((id) => state.people.get(id)).filter(Boolean).map(personView),
    reach: active.length,
  };
}

function linkProject(projectId, body) {
  if (!state.projects.has(projectId)) state.projects.set(projectId, { lists: new Set(), people: new Set() });
  const link = state.projects.get(projectId);
  for (const id of Array.isArray(body.list_ids) ? body.list_ids : []) if (state.lists.has(id)) link.lists.add(id);
  for (const id of Array.isArray(body.person_ids) ? body.person_ids : []) if (state.people.has(id)) link.people.add(id);
  // Like the API (participants_intake.collect_people): a refused address is reported, never a 400.
  const result = { created: 0, rejected: [] };
  for (const input of Array.isArray(body.people) ? body.people : []) {
    const outcome = upsertPerson(input);
    if (outcome.reason) { result.rejected.push({ email: text(input.email), reason: outcome.reason }); continue; }
    if (outcome.created) result.created += 1;
    link.people.add(outcome.row.person_id);
  }
  return [200, { ...projectView(projectId), ...result }];
}

function projectRoute(req, match, body) {
  const projectId = decodeURIComponent(match[1]);
  if (match[2] === undefined) {
    if (req.method === 'GET') return [200, projectView(projectId)];
    return req.method === 'POST' ? linkProject(projectId, body) : fail(405, 'Method not allowed');
  }
  if (req.method !== 'DELETE') return fail(405, 'Method not allowed');
  const link = state.projects.get(projectId);
  if (link) link[match[2] === 'lists' ? 'lists' : 'people'].delete(decodeURIComponent(match[3]));
  return [200, { success: true }];
}

function unsubscribe(url, body) {
  const token = text(body?.token) || url.searchParams.get('t') || '';
  // Mock tokens: `unsub_<person_id>`. Any other token is accepted silently (no existence leak).
  const row = state.people.get(token.replace(/^unsub_/u, ''));
  if (token.startsWith('unsub_') && row) Object.assign(row, { status: 'unsubscribed', unsubscribed_at: now() });
  return [200, { success: true }];
}

const sortedLists = () => [...state.lists.values()].sort((a, b) => a.name.localeCompare(b.name));

/** Exact paths: `METHOD path` → handler. */
const EXACT = {
  'POST /unsubscribe': (url, body) => unsubscribe(url, body),
  'GET /participants/settings': () => [200, settingsView()],
  'PUT /participants/settings': (_url, body) => putSettings(body),
  'GET /participants/lists': () => [200, { lists: sortedLists() }],
  'POST /participants/lists': (_url, body) => saveList(body, null),
  'GET /participants/people': (url) => listPeople(url),
};
const EXACT_PATHS = new Set(Object.keys(EXACT).map((key) => key.split(' ')[1]));

function route(req, url, body) {
  const handler = EXACT[`${req.method} ${url.pathname}`];
  if (handler) return handler(url, body);
  if (EXACT_PATHS.has(url.pathname)) return fail(405, 'Method not allowed');
  return subRoute(req, url, body);
}

function subRoute(req, url, body) {
  const path = url.pathname;
  const list = path.match(/^\/participants\/lists\/([^/]+)(?:\/(.+))?$/u);
  if (list) return listRoute(req, decodeURIComponent(list[1]), list[2], body);
  const person = path.match(/^\/participants\/people\/([^/]+)$/u);
  if (person) return personRoute(req, decodeURIComponent(person[1]), body);
  const project = path.match(/^\/participants\/projects\/([^/]+)(?:\/(lists|people)\/([^/]+))?$/u);
  if (project) return projectRoute(req, project, body);
  // The mock server's generic miss, so check:mock still sees an unmocked path as one.
  return askRoute(req, url, body) ?? [404, { error: 'Not found' }];
}

/** Returns true when it handled the request. */
export function handleParticipantsRoutes(req, res, url, send, shared) {
  if (url.pathname !== '/unsubscribe' && !url.pathname.startsWith('/participants/')) return false;
  shared.collectJson(req, res, (body) => {
    const [status, payload] = route(req, url, body ?? {});
    send(status, payload);
  });
  return true;
}
