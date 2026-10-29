// Feedback-board requests mock (docs/feature-requests.md): /feature-requests/*, in the
// lambda/api/engagement_handler.py wire shape (`{request, supports}`, `{requests, board, viewer}`,
// errors as `{success: false, error}`, as shared/api.py answers). Stateful for the life of the mock
// process; totals are RECOMPUTED from the support rows on every change, as the backend does. Every
// request belongs to a board (mock-boards.js; no `board_id` = the seeded Sales board), whose fields
// and statuses its writes are checked against. Wired into mock-server.js by handleDomainModules.
//
// The viewer is the mock's admin app user. Send `x-mock-board-viewer: board` to act as a board-pool
// user (never an admin), which is how the 403 paths of status / delete / promote are reached.
import {
  Refusal, SEEDED_BOARD_ID, SUPPORT_KEYS, boardFor, boardWire, fieldValues, handleBoardRoutes, refuse, registerRequestQueries, templateOfBoard,
} from './mock-boards.js';

const PATH = /^\/feature-requests(?:\/([^/]+)(?:\/(status|promote|supports)(?:\/([^/]+))?)?)?$/;
/** An `anyone` board's per-poster daily cap on new requests (the API's own; 429 `rate_limited`). */
const DAILY_REQUESTS_PER_POSTER = 20;
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
/** The mock deployment refuses external people (allow_external_people false), so promote reports a skip. */
const COMPANY_DOMAINS = ['example.com'];

const ADMIN_VIEWER = { email: 'admin@example.com', name: 'Admin Demo', is_admin: true, pool: 'app' };
const BOARD_VIEWER = { email: 'sam.seller@example.com', name: 'Sam Seller', is_admin: false, pool: 'board' };

const fail = (status, error) => [status, { success: false, error }];
const counter = { next: 100 };
const newId = (prefix) => `${prefix}_${(counter.next++).toString(16).padStart(16, '0')}`;
const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

function support(id, fields, created) {
  return {
    support_id: id, deal: undefined, contact_email: undefined, note: undefined, is_reporter: false,
    created_at: created, updated_at: created, ...fields,
  };
}

function fixtureRequest(id, fields, supports) {
  return {
    meta: {
      request_id: id, status: 'new', project_id: undefined, list_id: undefined, board_id: SEEDED_BOARD_ID,
      totals: { supporters: 0, customers: 0, committed_usd: 0, at_risk_usd: 0 }, ...fields,
      updated_at: fields.created_at,
    },
    supports,
  };
}

const store = new Map([
  ['fr_0000000000000001', fixtureRequest('fr_0000000000000001', {
    title: 'Single sign-on with SAML for customer admins',
    description: 'Enterprise customers need their admins to sign in through their own identity provider.',
    // A pre-boards request: no board_id, so it reads as the seeded Sales board's.
    status: 'under_review', reporter_email: 'dana.lee@example.com', reporter_name: 'Dana Lee', created_at: daysAgo(12), board_id: undefined,
  }, [
    support('sup_0000000000000001', {
      email: 'dana.lee@example.com', name: 'Dana Lee', customer: 'Acme', deal: 'Acme renewal FY27', impact: 'at_risk',
      amount_usd: 240000, contact_email: 'it-lead@acme.example', note: 'Renewal is blocked on SSO.', is_reporter: true,
    }, daysAgo(12)),
    support('sup_0000000000000002', {
      email: 'rui.costa@example.com', name: 'Rui Costa', customer: 'Example Air', impact: 'committed', amount_usd: 85000,
      note: 'Would sign the expansion this quarter.',
    }, daysAgo(6)),
  ])],
  ['fr_0000000000000002', fixtureRequest('fr_0000000000000002', {
    title: 'Export dashboards to PDF',
    description: 'Sales teams want to send the weekly dashboard to customers as a PDF.',
    status: 'new', reporter_email: 'sam.seller@example.com', reporter_name: 'Sam Seller', created_at: daysAgo(3),
  }, [
    support('sup_0000000000000003', {
      email: 'sam.seller@example.com', name: 'Sam Seller', customer: 'Example Air', impact: 'none', amount_usd: 0, is_reporter: true,
    }, daysAgo(3)),
  ])],
  ['fr_0000000000000003', fixtureRequest('fr_0000000000000003', {
    title: 'Offline mode for the field app',
    description: 'Crews work without signal; the app should queue changes and sync later.',
    status: 'planned', reporter_email: 'ana.ruiz@example.com', reporter_name: 'Ana Ruiz', created_at: daysAgo(30),
  }, [
    support('sup_0000000000000004', {
      email: 'ana.ruiz@example.com', name: 'Ana Ruiz', customer: 'Acme', impact: 'committed', amount_usd: 120000, is_reporter: true,
    }, daysAgo(30)),
    support('sup_0000000000000005', {
      email: 'rui.costa@example.com', name: 'Rui Costa', customer: 'acme', deal: 'Acme field rollout', impact: 'at_risk',
      amount_usd: 60000, contact_email: 'ops@acme.example',
    }, daysAgo(20)),
  ])],
  ['fr_0000000000000004', fixtureRequest('fr_0000000000000004', {
    title: 'Refund email never arrives', board_id: 'brd_service', status: 'confirmed',
    description: 'Customers who cancel a booking are told a refund email is on its way; it never comes.',
    reporter_email: 'ana.ruiz@example.com', reporter_name: 'Ana Ruiz', created_at: daysAgo(5),
    fields: { kind: 'bug', severity: 'high', reference: 'BK-10442', steps: 'Cancel a booking, then wait for the refund email.', affected_count: 12 },
  }, [
    support('sup_0000000000000006', { email: 'ana.ruiz@example.com', name: 'Ana Ruiz', is_reporter: true }, daysAgo(5)),
    support('sup_0000000000000007', { email: 'rui.costa@example.com', name: 'Rui Costa', note: 'Two more calls today.' }, daysAgo(2)),
  ])],
  ['fr_0000000000000005', fixtureRequest('fr_0000000000000005', {
    title: 'The new checkout hides the promo code field', board_id: 'brd_beta',
    description: 'Testers could not find where to enter a promo code.',
    reporter_email: 'sam.seller@example.com', reporter_name: 'Sam Seller', created_at: daysAgo(1),
    fields: { area: 'Checkout', outcome: 'confusing', rating: 3, link: 'https://beta.example.com/checkout' },
  }, [
    support('sup_0000000000000008', { email: 'sam.seller@example.com', name: 'Sam Seller', is_reporter: true }, daysAgo(1)),
  ])],
]);

const boardIdOf = (entry) => entry.meta.board_id ?? SEEDED_BOARD_ID;
registerRequestQueries({
  count: (boardId) => [...store.values()].filter((entry) => boardIdOf(entry) === boardId).length,
  statusInUse: (boardId, key) => [...store.values()].some((entry) => boardIdOf(entry) === boardId && entry.meta.status === key),
  /** Deletes up to `limit` of the board's requests (with their supports); answers how many. */
  deletePage: (boardId, limit) => {
    const page = [...store.entries()].filter(([, entry]) => boardIdOf(entry) === boardId).slice(0, limit);
    for (const [id] of page) store.delete(id);
    return page.length;
  },
});

function salesTotals(rows) {
  const sum = (impact) => rows.filter((row) => row.impact === impact).reduce((total, row) => total + (row.amount_usd ?? 0), 0);
  return {
    customers: new Set(rows.map((row) => String(row.customer ?? '').trim().toLowerCase()).filter(Boolean)).size,
    committed_usd: sum('committed'),
    at_risk_usd: sum('at_risk'),
  };
}

/** The board template's totals (feature_requests_store.compute_totals): sales money, service `affected`, beta `avg_rating`. */
function recompute(entry) {
  const template = templateOfBoard(boardIdOf(entry));
  const values = entry.meta.fields ?? {};
  const supporters = new Set(entry.supports.map((row) => row.email)).size;
  const extra = {
    sales: () => salesTotals(entry.supports),
    service: () => ({ affected: Math.max(values.affected_count ?? 1, 1) + Math.max(supporters - 1, 0) }),
    beta: () => ({ avg_rating: Number.isInteger(values.rating) ? values.rating : null }),
    blank: () => ({}),
  }[template]();
  entry.meta.totals = { supporters, ...extra };
  entry.meta.updated_at = new Date().toISOString();
}
for (const entry of store.values()) recompute(entry);

function text(body, name, { max, required }) {
  const value = body[name];
  if (value === undefined || value === null || value === '') {
    if (required) refuse(400, `${name} is required`);
    return undefined;
  }
  if (typeof value !== 'string') refuse(400, `${name} must be text`);
  const trimmed = value.trim();
  if (required && trimmed === '') refuse(400, `${name} is required`);
  if (trimmed.length > max) refuse(400, `${name} must be at most ${max} characters`);
  return trimmed === '' ? undefined : trimmed;
}

/** A support's stored values (top-level, as before boards), checked against the board's +1 fields. */
function supportValues(body, target) {
  const values = fieldValues(target, 'support', body);
  if (values.contact_email !== undefined && !EMAIL.test(values.contact_email)) refuse(400, 'contact_email is not an email address');
  return { ...values, contact_email: values.contact_email?.toLowerCase(), name: text(body, 'name', { max: 160, required: true }) };
}

/** The reporter's own +1: the request values the board's +1s ask for (legacy bodies: read with the +1 rules). */
function reporterSupport(body, target, values) {
  if (body.fields === undefined) return supportValues(body, target);
  const enabled = SUPPORT_KEYS.filter((key) => target.fields.support[key]?.enabled);
  return { ...Object.fromEntries(Object.entries(values).filter(([key]) => enabled.includes(key))), name: text(body, 'name', { max: 160, required: true }) };
}

/** The request and its board, as `viewer` may see them (a request on an invisible board is a 404 too). */
function find(requestId, viewer) {
  const entry = store.get(requestId) ?? refuse(404, 'Feature request not found');
  try {
    return { entry, board: boardFor(boardIdOf(entry), viewer) };
  } catch {
    return refuse(404, 'Feature request not found');
  }
}

const postsToday = new Map();
/** An `anyone` board caps each poster's new requests per UTC day. */
function countPost(target, viewer) {
  if (target.audience.mode !== 'anyone' || viewer.pool === 'app') return;
  const key = `${target.board_id}#${viewer.email}#${new Date().toISOString().slice(0, 10)}`;
  const count = (postsToday.get(key) ?? 0) + 1;
  if (count > DAILY_REQUESTS_PER_POSTER) refuse(429, 'rate_limited');
  postsToday.set(key, count);
}

/** A support as the API shows it: its stored values, and the same values under `fields`. */
const supportView = (row) => ({ ...row, fields: Object.fromEntries(SUPPORT_KEYS.filter((key) => row[key] !== undefined).map((key) => [key, row[key]])) });
const requestView = (entry) => ({ ...entry.meta, board_id: boardIdOf(entry), fields: entry.meta.fields ?? {} });
const detail = (entry) => ({ request: requestView(entry), supports: entry.supports.map(supportView) });

/** Templates whose requests need a description (shared/feature_board_fields.py DESCRIPTION_REQUIRED_TEMPLATES). */
const DESCRIPTION_REQUIRED = new Set(['sales', 'service']);

const descriptionOf = (body, template) =>
  text(body, 'description', { max: 4000, required: DESCRIPTION_REQUIRED.has(template) }) ?? '';

function createRequest(body, viewer) {
  const target = boardFor(typeof body.board === 'string' && body.board !== '' ? body.board : SEEDED_BOARD_ID, viewer);
  const title = text(body, 'title', { max: 160, required: true });
  // Required on sales/service boards, else optional (absent or blank is ''), like the API.
  const description = descriptionOf(body, target.template);
  const values = fieldValues(target, 'request', body);
  const fields = reporterSupport(body, target, values);
  countPost(target, viewer);
  const now = new Date().toISOString();
  const requestId = newId('fr');
  const entry = fixtureRequest(requestId, {
    title, description, reporter_email: viewer.email, reporter_name: fields.name, created_at: now,
    board_id: target.board_id, status: target.statuses[0].key, fields: values,
  }, [support(newId('sup'), { ...fields, email: viewer.email, is_reporter: true }, now)]);
  recompute(entry);
  store.set(requestId, entry);
  return [201, detail(entry)];
}

function updateRequest(entry, body, viewer) {
  if (!viewer.is_admin && entry.meta.reporter_email !== viewer.email) refuse(403, 'Only the reporter or an admin can edit this request');
  if (body.title === undefined && body.description === undefined) refuse(400, 'Nothing to update: send title or description');
  if (body.title !== undefined) entry.meta.title = text(body, 'title', { max: 160, required: true });
  if (body.description !== undefined) entry.meta.description = descriptionOf(body, templateOfBoard(entry.meta.board_id ?? SEEDED_BOARD_ID));
  entry.meta.updated_at = new Date().toISOString();
  return [200, { request: requestView(entry) }];
}

function requireAdmin(viewer) {
  if (!viewer.is_admin) refuse(403, 'Only an admin can do that');
}

function setStatus({ entry, board }, body, viewer) {
  requireAdmin(viewer);
  const keys = board.statuses.map((status) => status.key);
  if (!keys.includes(body.status)) refuse(400, `status must be one of: ${keys.join(', ')}`);
  entry.meta.status = body.status;
  entry.meta.updated_at = new Date().toISOString();
  return [200, { request: requestView(entry) }];
}

function addSupport({ entry, board }, body, viewer) {
  // One +1 per person per request, the reporter's own included (feature_requests_routes.py).
  const email = viewer.email.toLowerCase();
  if (entry.supports.some((row) => row.email.toLowerCase() === email)) refuse(409, 'already_supported');
  const now = new Date().toISOString();
  const row = support(newId('sup'), { ...supportValues(body, board), email: viewer.email }, now);
  entry.supports.push(row);
  recompute(entry);
  return [201, { support: supportView(row), request: requestView(entry) }];
}

function changeSupport({ entry, board }, supportId, body, viewer, method) {
  const row = entry.supports.find((candidate) => candidate.support_id === supportId) ?? refuse(404, 'Support not found');
  if (!viewer.is_admin && row.email !== viewer.email) refuse(403, 'Only its author or an admin can change this support');
  if (method === 'DELETE') entry.supports = entry.supports.filter((candidate) => candidate !== row);
  else {
    for (const key of SUPPORT_KEYS) delete row[key];
    Object.assign(row, supportValues(body, board), { updated_at: new Date().toISOString() });
  }
  recompute(entry);
  return [200, { request: requestView(entry) }];
}

function promote({ entry }, body, viewer, shared) {
  requireAdmin(viewer);
  const projectId = typeof body.project_id === 'string' ? body.project_id : '';
  if (!shared.mockProjectDetails[projectId]) refuse(404, 'Project not found');
  const supporters = entry.supports.map((row) => row.email);
  const contacts = entry.supports.map((row) => row.contact_email).filter(Boolean);
  const emails = [...new Set([...supporters, ...contacts])];
  const internal = (email) => COMPANY_DOMAINS.includes(email.split('@')[1] ?? '');
  const listId = entry.meta.list_id ?? newId('lst');
  const listName = `Requests: ${entry.meta.title}`;
  entry.meta.project_id = projectId;
  entry.meta.list_id = listId;
  if (entry.meta.status === 'new' || entry.meta.status === 'under_review') entry.meta.status = 'planned';
  entry.meta.updated_at = new Date().toISOString();
  return [200, {
    request: requestView(entry),
    list: { list_id: listId, name: listName, kind: 'requesters', feature_request_id: entry.meta.request_id, member_count: emails.filter(internal).length },
    added: emails.filter(internal).length,
    skipped: emails.filter((email) => !internal(email)).map((email) => ({ email, reason: 'external_not_allowed' })),
  }];
}

function listRequests(viewer, boardRef) {
  const target = boardFor(boardRef ?? SEEDED_BOARD_ID, viewer);
  const requests = [...store.values()]
    .filter((entry) => boardIdOf(entry) === target.board_id)
    .map(requestView)
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  return [200, { requests, board: boardWire(target, viewer), viewer }];
}

function requestRoute(req, { entry }, body, viewer) {
  if (req.method === 'GET') return [200, detail(entry)];
  if (req.method === 'PUT') return updateRequest(entry, body, viewer);
  if (req.method === 'DELETE') {
    requireAdmin(viewer);
    store.delete(entry.meta.request_id);
    return [200, { success: true }];
  }
  return fail(405, 'Method not allowed');
}

const SUB_ROUTES = {
  'PUT status': (entry, body, viewer) => setStatus(entry, body, viewer),
  'POST promote': (entry, body, viewer, shared) => promote(entry, body, viewer, shared),
  'POST supports': (entry, body, viewer) => addSupport(entry, body, viewer),
};

function route(req, match, body, viewer, shared, url) {
  const [, rawId, sub, rawSupportId] = match;
  if (rawId === undefined) {
    if (req.method === 'GET') return listRequests(viewer, url.searchParams.get('board') ?? undefined);
    if (req.method === 'POST') return createRequest(body, viewer);
    return fail(405, 'Method not allowed');
  }
  const entry = find(decodeURIComponent(rawId), viewer);
  if (sub === undefined) return requestRoute(req, entry, body, viewer);
  if (sub === 'supports' && rawSupportId !== undefined && (req.method === 'PUT' || req.method === 'DELETE')) {
    return changeSupport(entry, decodeURIComponent(rawSupportId), body, viewer, req.method);
  }
  const handler = rawSupportId === undefined ? SUB_ROUTES[`${req.method} ${sub}`] : undefined;
  return handler ? handler(entry, body, viewer, shared) : fail(405, 'Method not allowed');
}

/** Returns true when it handled the request. */
const viewerOf = (req) => (req.headers['x-mock-board-viewer'] === 'board' ? BOARD_VIEWER : ADMIN_VIEWER);

export function handleFeatureRequestRoutes(req, res, url, send, shared) {
  if (handleBoardRoutes(req, res, url, send, shared, viewerOf)) return true;
  const match = url.pathname.match(PATH);
  if (!match) return false;
  const viewer = viewerOf(req);
  shared.collectJson(req, res, (body) => {
    try {
      send(...route(req, match, body ?? {}, viewer, shared, url));
    } catch (error) {
      if (error instanceof Refusal) send(...fail(error.status, error.message));
      else send(...fail(500, 'Mock error'));
    }
  });
  return true;
}
