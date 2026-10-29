// Feedback boards mock (docs/feature-requests.md): /feature-requests/boards*, in the
// lambda/shared/feature_boards*.py wire shape (`{boards, viewer}`, `{board}`, errors as
// `{success: false, error}`). Stateful for the life of the mock process. Seeded with the Sales board
// every pre-boards request belongs to, plus one Service and one Beta board with other audiences.
// The field catalogue + template defaults mirror src/api/boardFields.ts (the SPA's own mirror of
// lambda/shared/feature_board_fields.py). Reached through mock-feature-requests.js, which hands
// `/feature-requests/boards*` here BEFORE its own `/feature-requests/{id}` pattern could claim it.
//
// The 409s come from the seeded requests (mock-feature-requests.js): a plain Delete of the Sales board
// answers `board_not_empty` (`?with_requests=true` deletes its requests DELETE_PAGE per call, archiving
// the board on the first, and the board once none remain: `{success, done, deleted, remaining}`), removing its `under_review` or `planned` status `status_in_use`, and a slug held
// by another board `slug_taken`.
//
// The viewer is the mock's admin app user; `x-mock-board-viewer: board` acts as a board-pool user
// (sam.seller@example.com, company domain example.com), who sees only the boards that admit them.

export const SEEDED_BOARD_ID = 'brd_sales';
const FRONTEND = 'http://localhost:5173';
const COMPANY_DOMAINS = ['example.com'];
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const STATUS_KEY = /^[a-z_]{1,30}$/;

export class Refusal extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
export const refuse = (status, message) => {
  throw new Refusal(status, message);
};

const choice = (choices) => ({ type: 'choice', choices });
const FIELD_SPECS = {
  customer: { type: 'text', max: 160 }, deal: { type: 'text', max: 160 }, impact: choice(['committed', 'at_risk', 'none']),
  amount_usd: { type: 'int', min: 0, max: 10_000_000_000 }, contact_email: { type: 'text', max: 254 },
  kind: choice(['bug', 'complaint', 'missing_feature', 'question']), severity: choice(['low', 'medium', 'high', 'critical']),
  reference: { type: 'text', max: 80 }, steps: { type: 'text', max: 2000 }, affected_count: { type: 'int', min: 1, max: 1_000_000_000 },
  area: { type: 'text', max: 80 }, outcome: choice(['works', 'broken', 'confusing']), rating: { type: 'int', min: 1, max: 5 },
  link: { type: 'url', max: 500 }, note: { type: 'text', max: 1000 },
};
/** Each level's catalogue: `request` (New request) and `support` (a +1). */
const LEVEL_KEYS = {
  request: ['customer', 'deal', 'impact', 'amount_usd', 'contact_email', 'kind', 'severity', 'reference', 'steps', 'affected_count', 'area', 'outcome', 'rating', 'link'],
  support: ['customer', 'deal', 'impact', 'amount_usd', 'contact_email', 'note'],
};
export const SUPPORT_KEYS = LEVEL_KEYS.support;

const statuses = (pairs) => pairs.map(([key, label]) => ({ key, label }));
const OFF = { enabled: false, required: false };
const levelWith = (level, on = {}) => Object.fromEntries(LEVEL_KEYS[level].map((key) => [key, on[key] ?? OFF]));
const ON = { enabled: true, required: false };
const REQ = { enabled: true, required: true };
const SALES_KEYS = { customer: REQ, deal: ON, impact: REQ, amount_usd: ON, contact_email: ON };
const NOTE_ONLY = levelWith('support', { note: ON });
const TEMPLATES = {
  sales: {
    fields: { request: levelWith('request', SALES_KEYS), support: levelWith('support', { ...SALES_KEYS, note: ON }) },
    statuses: statuses([['new', 'New'], ['under_review', 'Under review'], ['planned', 'Planned'], ['shipped', 'Shipped'], ['declined', 'Declined']]),
  },
  service: {
    fields: { request: levelWith('request', { kind: REQ, severity: REQ, reference: ON, steps: ON, affected_count: ON }), support: NOTE_ONLY },
    statuses: statuses([['new', 'New'], ['confirmed', 'Confirmed'], ['fixed', 'Fixed'], ['wont_fix', "Won't fix"]]),
  },
  beta: {
    fields: { request: levelWith('request', { area: REQ, outcome: REQ, rating: ON, link: ON }), support: NOTE_ONLY },
    statuses: statuses([['new', 'New'], ['seen', 'Seen'], ['fixed', 'Fixed']]),
  },
  blank: { fields: { request: levelWith('request'), support: levelWith('support') }, statuses: statuses([['new', 'New'], ['done', 'Done']]) },
};

const now = () => new Date().toISOString();
const counter = { next: 1 };
const newBoardId = () => `brd_${(0xa0000000 + counter.next++).toString(16)}`;

function board(boardId, slug, name, template, audience, description = '') {
  const created = now();
  return {
    board_id: boardId, slug, name, description, template, archived: false, paused: false, audience,
    fields: structuredClone(TEMPLATES[template].fields), statuses: structuredClone(TEMPLATES[template].statuses),
    created_at: created, created_by: 'admin@example.com', updated_at: created,
  };
}

const boards = new Map([
  [SEEDED_BOARD_ID, board(SEEDED_BOARD_ID, 'sales-feature-requests', 'Sales feature requests', 'sales', { mode: 'company', domains: [], emails: [] },
    'Requests from the field, with the customers and revenue behind each one.')],
  ['brd_service', board('brd_service', 'customer-service-issues', 'Customer service issues', 'service',
    { mode: 'list', domains: ['acme.example'], emails: ['pat.lee@example.org'] }, 'Issues our service team hears from customers.')],
  ['brd_beta', board('brd_beta', 'beta-feedback', 'Beta feedback', 'beta', { mode: 'anyone', domains: [], emails: [] },
    'What beta testers find in the new checkout.')],
]);

/** What the feature-request module (which owns the requests) answers about a board's requests. */
const requests = { count: () => 0, statusInUse: () => false, deletePage: () => 0 };
export function registerRequestQueries(queries) {
  Object.assign(requests, queries);
}

function admits(target, viewer) {
  if (viewer.pool === 'app') return viewer.is_admin || !target.archived;
  if (target.archived) return false;
  const domain = viewer.email.split('@')[1] ?? '';
  if (target.audience.mode === 'anyone') return true;
  if (target.audience.mode === 'company') return COMPANY_DOMAINS.includes(domain);
  return target.audience.domains.includes(domain) || target.audience.emails.includes(viewer.email);
}

/** A board's template, `sales` for a board that is gone (its requests are then unreachable anyway). */
export function templateOfBoard(boardId) {
  return boards.get(boardId)?.template ?? 'sales';
}

export function boardWire(target, viewer) {
  const audience = viewer.is_admin ? structuredClone(target.audience) : { mode: target.audience.mode };
  const wire = {
    ...structuredClone(target), audience, share_url: `${FRONTEND}/board/${target.slug}`,
    request_count: requests.count(target.board_id),
  };
  // Who created or paused it (Cognito subs in the API) is for admins only (feature_boards_store.board_view).
  if (!viewer.is_admin) {
    delete wire.created_by;
    delete wire.paused_by;
  }
  return wire;
}

/** `paused` set by an admin: pausing stamps who and when, resuming clears them (feature_boards_store.with_pause_stamp). */
function applyPaused(target, raw, viewer) {
  if (raw === undefined || raw === target.paused) return;
  target.paused = raw;
  if (raw) Object.assign(target, { paused_at: now(), paused_by: viewer.email });
  else {
    delete target.paused_at;
    delete target.paused_by;
  }
}

/** A paused board takes no new request, +1 or edit (409 `board_paused`, feature_requests_routes.py). */
export function refuseWhenPaused(target) {
  if (target.paused === true) refuse(409, 'board_paused');
}

/** The board `ref` (slug or id) names, as `viewer` may see it; 404 otherwise (no existence leak). */
export function boardFor(ref, viewer) {
  const found = boards.get(ref) ?? [...boards.values()].find((candidate) => candidate.slug === ref);
  if (!found || !admits(found, viewer)) refuse(404, 'Board not found');
  return found;
}

function valueError(key, value, required) {
  if (value === undefined || value === null || value === '') return required ? `${key} is required` : undefined;
  const spec = FIELD_SPECS[key];
  if (spec.type === 'choice') return spec.choices.includes(value) ? undefined : `${key} must be one of: ${spec.choices.join(', ')}`;
  if (spec.type === 'int') return Number.isInteger(value) && value >= spec.min && value <= spec.max ? undefined : `${key} must be a whole number from ${spec.min} to ${spec.max}`;
  if (typeof value !== 'string' || value.length > spec.max) return `${key} must be text of at most ${spec.max} characters`;
  return spec.type === 'url' && !/^https:\/\/[^\s/]+/.test(value) ? `${key} must be an https link` : undefined;
}

/** The body's values: its `fields` object (strict), or — a client from before boards — the level's keys at the top level. */
function sourceOf(body, level) {
  if (body.fields === undefined || body.fields === null) {
    return { given: Object.fromEntries(LEVEL_KEYS[level].filter((key) => key in body).map((key) => [key, body[key]])), strict: false };
  }
  if (typeof body.fields !== 'object' || Array.isArray(body.fields)) refuse(400, 'fields must be an object');
  return { given: body.fields, strict: true };
}

/** A committed / at-risk impact carries its amount; no impact stores 0 (as before boards). */
function impactAmount(values, flags) {
  if (values.impact === undefined || !flags.amount_usd.enabled) return;
  if (values.impact === 'none') values.amount_usd = 0;
  else if (values.amount_usd === undefined) refuse(400, 'amount_usd must be a whole number of US dollars');
}

/** The values of `target`'s enabled `level` fields in `body`, checked (shared/feature_board_fields.field_values). */
export function fieldValues(target, level, body) {
  const flagsOf = target.fields[level];
  const { given, strict } = sourceOf(body, level);
  const enabled = Object.keys(flagsOf).filter((key) => flagsOf[key].enabled);
  const extra = strict ? Object.keys(given).filter((key) => !enabled.includes(key)) : [];
  if (extra.length > 0) refuse(400, `${extra[0]} is not a field of this board`);
  const values = {};
  for (const key of enabled) {
    const error = valueError(key, given[key], flagsOf[key].required);
    if (error) refuse(400, error);
    if (given[key] !== undefined && given[key] !== null && given[key] !== '') values[key] = given[key];
  }
  impactAmount(values, flagsOf);
  return values;
}

function requireAdmin(viewer) {
  if (!viewer.is_admin) refuse(403, 'Only an admin can do that');
}

function slugOf(name) {
  const words = name.toLowerCase().split(/[^a-z0-9]/).filter(Boolean);
  const slug = words.join('-').slice(0, 60);
  return (slug.endsWith('-') ? slug.slice(0, -1) : slug) || 'board';
}

function claimSlug(slug, boardId) {
  if (!SLUG.test(slug) || slug.length > 60) refuse(400, 'slug must be lower-case words joined by hyphens');
  const holder = [...boards.values()].find((candidate) => candidate.slug === slug);
  if (holder && holder.board_id !== boardId) refuse(409, 'slug_taken');
}

function readAudience(raw) {
  if (raw === undefined) return { mode: 'company', domains: [], emails: [] };
  if (!['company', 'list', 'anyone'].includes(raw?.mode)) refuse(400, 'audience.mode must be company, list or anyone');
  const lower = (items) => (Array.isArray(items) ? items.map((item) => String(item).trim().toLowerCase()).filter(Boolean) : []);
  const [domains, emails] = [lower(raw.domains), lower(raw.emails)];
  if (domains.length > 50) refuse(400, 'audience.domains: at most 50');
  if (emails.length > 500) refuse(400, 'audience.emails: at most 500');
  return { mode: raw.mode, domains, emails };
}

const validName = (name) => typeof name === 'string' && name.trim() !== '' && name.trim().length <= 80;

function createBoard(body, viewer) {
  requireAdmin(viewer);
  if (!validName(body.name)) refuse(400, 'name is required (at most 80 characters)');
  const name = body.name.trim();
  if (!TEMPLATES[body.template]) refuse(400, 'template must be sales, service, beta or blank');
  const boardId = newBoardId();
  const slug = typeof body.slug === 'string' && body.slug !== '' ? body.slug : slugOf(name);
  claimSlug(slug, boardId);
  const created = board(boardId, slug, name, body.template, readAudience(body.audience), String(body.description ?? '').slice(0, 1000));
  boards.set(boardId, created);
  return [201, { board: boardWire(created, viewer) }];
}

function readStatuses(raw, target, inUse) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 8) refuse(400, 'statuses must be 1 to 8 entries');
  const next = raw.map((item) => ({ key: String(item?.key ?? ''), label: String(item?.label ?? '').trim() }));
  if (next.some((item) => !STATUS_KEY.test(item.key) || item.label === '')) refuse(400, 'every status needs a key and a label');
  const removed = target.statuses.filter((old) => !next.some((item) => item.key === old.key));
  if (removed.some((old) => inUse(old.key))) refuse(409, 'status_in_use');
  return next;
}

/** The board's `fields` as the API stores them: `{request, support}`, each key of its level's catalogue. */
function readFieldsConfig(raw) {
  const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isObject(raw) || Object.keys(raw).some((level) => !(level in LEVEL_KEYS))) refuse(400, 'fields must be {request, support}');
  for (const level of Object.keys(LEVEL_KEYS)) {
    const given = raw[level] ?? {};
    if (!isObject(given)) refuse(400, `fields.${level} must be an object`);
    const unknown = Object.keys(given).find((key) => !LEVEL_KEYS[level].includes(key));
    if (unknown) refuse(400, `fields.${level}: unknown field ${unknown}`);
    const lax = Object.entries(given).find(([, flags]) => flags?.required === true && flags?.enabled !== true);
    if (lax) refuse(400, `fields.${level}.${lax[0]} cannot be required while it is off`);
  }
  return { request: levelWith('request', raw.request), support: levelWith('support', raw.support) };
}

function updateBoard(target, body, viewer, inUse) {
  requireAdmin(viewer);
  if (body.name !== undefined && !validName(body.name)) refuse(400, 'name is required (at most 80 characters)');
  if (body.paused !== undefined && typeof body.paused !== 'boolean') refuse(400, 'paused must be true or false');
  if (body.slug !== undefined) claimSlug(String(body.slug), target.board_id);
  const next = {
    fields: body.fields === undefined ? target.fields : readFieldsConfig(body.fields),
    statuses: body.statuses === undefined ? target.statuses : readStatuses(body.statuses, target, inUse),
    audience: body.audience === undefined ? target.audience : readAudience(body.audience),
  };
  if (body.name !== undefined) target.name = body.name.trim();
  if (body.slug !== undefined) target.slug = String(body.slug);
  if (body.description !== undefined) target.description = String(body.description).slice(0, 1000);
  Object.assign(target, next);
  if (body.archived !== undefined) target.archived = body.archived === true;
  applyPaused(target, body.paused, viewer);
  target.updated_at = now();
  return [200, { board: boardWire(target, viewer) }];
}

/** Requests one `?with_requests=true` call deletes: small, so the SPA's repeat-until-done loop runs. */
const DELETE_PAGE = 2;

function deleteBoard(target, viewer, withRequests) {
  requireAdmin(viewer);
  if (!withRequests && requests.count(target.board_id) > 0) refuse(409, 'board_not_empty');
  const deleted = withRequests ? requests.deletePage(target.board_id, DELETE_PAGE) : 0;
  const remaining = requests.count(target.board_id);
  if (remaining > 0) {
    target.archived = true;
    target.updated_at = now();
    return [200, { success: true, done: false, deleted, remaining }];
  }
  boards.delete(target.board_id);
  return [200, { success: true, done: true, deleted, remaining: 0 }];
}

const PATH = /^\/feature-requests\/boards(?:\/([^/]+))?$/;

function route(req, url, match, body, viewer) {
  const [, rawRef] = match;
  if (rawRef === undefined) {
    if (req.method === 'GET') {
      const visible = [...boards.values()].filter((candidate) => admits(candidate, viewer)).sort((a, b) => a.name.localeCompare(b.name));
      return [200, { boards: visible.map((candidate) => boardWire(candidate, viewer)), viewer }];
    }
    if (req.method === 'POST') return createBoard(body, viewer);
    return [405, { success: false, error: 'Method not allowed' }];
  }
  const target = boardFor(decodeURIComponent(rawRef), viewer);
  if (req.method === 'GET') return [200, { board: boardWire(target, viewer) }];
  if (req.method === 'PUT') return updateBoard(target, body, viewer, (key) => requests.statusInUse(target.board_id, key));
  if (req.method === 'DELETE') return deleteBoard(target, viewer, url.searchParams.get('with_requests') === 'true');
  return [405, { success: false, error: 'Method not allowed' }];
}

/** Returns true when it handled the request. `viewerOf(req)` is the feature-request module's viewer. */
export function handleBoardRoutes(req, res, url, send, shared, viewerOf) {
  const match = url.pathname.match(PATH);
  if (!match) return false;
  shared.collectJson(req, res, (body) => {
    try {
      send(...route(req, url, match, body ?? {}, viewerOf(req)));
    } catch (error) {
      if (error instanceof Refusal) send(error.status, { success: false, error: error.message });
      else send(500, { success: false, error: 'Mock error' });
    }
  });
  return true;
}
