// Workspaces mock, in the wire shapes of lambda/api/workspaces_handler.py (docs/multi-workspace.md):
//   GET  /me/workspaces                          → {workspaces: [{id, name, slug, role}]}, by name
//   GET  /me/workspaces/current                  → {workspace: {id, name, slug, role, platform_admin}} for X-Workspace-Id
//   GET  /me/workspaces/current/members          → {members: [{sub, role, email, name, invited_by, joined_at}], next_cursor}
//   POST /me/workspaces/current/members          {email, role} → 201 {member: {…, account: 'existing'|'created'}}
//   PUT  /me/workspaces/current/members/{sub}    {role} → {member: {sub, role}}
//   DELETE /me/workspaces/current/members/{sub}  → {removed: sub} (the caller's own sub: leave)
//   GET  /platform/workspaces                    → {workspaces: [{id, name, slug, status, created_at, secret_status}], next_cursor}
//   POST /platform/workspaces                    {name, slug} → 201 {workspace: {id, name, slug, role: 'admin', secret_status}}
// The workspace routes answer 400 without X-Workspace-Id and one 404 for any workspace the caller cannot enter
// (never "exists"); the writes refuse as workspace_members.py does (403 for a non-admin, 409 for the last admin, a
// person already a member or an email spelt as another account's, 404 for a non-member). The /platform routes
// answer 403 unless the caller (mock-server.js MOCK_CALLER) is in `platform-admins` in the mock's users, which
// `PUT /users/{username}/platform-admin` (mock-server.js) grants and revokes.
//
// Default: the mock deployment has NO workspace, like every deployment before workspaces, so `npm run dev` and the
// other mock e2e specs open the app as before; creating one is refused until the switch is on. The dev switch
// sets the state afresh each time:
//   curl -X PUT localhost:3001/__mock/workspaces -d '{"enabled":true}'   (false: none again), then reload.
// With it on, the caller (admin-demo, a platform admin) is the admin of "Acme Outfitters" (acme, with a viewer)
// and an editor of "Juniper Trail Co." (juniper, whose admin is editor-demo; its secret is pending). Unlike the
// server, which also lifts a platform admin who is a member below admin to admin, the mock lifts only a
// non-member (entering from the platform console), so the caller's own role shows in juniper.
// `{"enabled":true,"member":"acme"}`: the same two workspaces, but the caller is a member of acme only and these
// routes treat them as no platform admin (no entry, and 403 on /platform), so juniper answers the one 404
// (e2e/tests/cross-workspace.spec.ts).
// Wired into mock-server.js by handleDomainModules; the dev-only /__mock/workspaces route is not an app route.

const CONTROL_ROUTE = '/__mock/workspaces';
const MEMBERS_ROUTE = '/me/workspaces/current/members';
const MEMBER_ROUTE = /^\/me\/workspaces\/current\/members\/([^/]+)$/;
const PLATFORM_ROUTE = '/platform/workspaces';

const ROLES = ['admin', 'editor', 'viewer'];
const PLATFORM_ADMIN_GROUP = 'platform-admins';
/** Default page size of the list routes (parse_limit); ?limit= takes 1 to 100. */
const DEFAULT_LIMIT = 25;
/** platform_workspaces.py `_SLUG` and RESERVED_SLUGS. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const RESERVED_SLUGS = new Set(['admin', 'api', 'app', 'platform', 'www']);
const NAME_MAX = 80;

// The refusals' texts: workspace_members.py, workspace.py, platform_workspaces.py.
const NOT_FOUND = 'Workspace not found';
const MEMBER_NOT_FOUND = 'Member not found';
const NOT_WORKSPACE_ADMIN = 'Workspace admin access required';
const LAST_ADMIN = 'A workspace needs an admin: make another member an admin first';
const ALREADY_MEMBER = 'That person is already a member of this workspace';
const EMAIL_ELSEWHERE = 'An account already uses this email under another spelling: add it as that account writes it';
const SLUG_TAKEN = 'That slug is taken: choose another';
const NOT_PLATFORM_ADMIN = 'Platform admin access required';

const ACME_ID = 'ws_01JCACME0000000000000000A1';
const JUNIPER_ID = 'ws_01JCJNPR0000000000000000J1';
const DAY_MS = 86_400_000;

const state = { enabled: false, workspaces: [], created: 0, platformAdmin: true };

const daysAgo = (days) => new Date(Date.now() - days * DAY_MS).toISOString();

/** The two fictional workspaces of the switch, with their members (the caller's sub from mock-server.js). */
function fixtures(callerSub, subOf) {
  const member = (sub, role, email, name, invitedBy, days) => ({ sub, role, email, name, invited_by: invitedBy, joined_at: daysAgo(days) });
  return [
    {
      id: ACME_ID, name: 'Acme Outfitters', slug: 'acme', status: 'active', created_at: daysAgo(30), secret_status: 'ready',
      members: [
        // The creator's row holds no email or name: the server fills them from Cognito, as the mock does below.
        member(callerSub, 'admin', '', '', '', 30),
        member(subOf('viewer-demo'), 'viewer', 'viewer@example.com', 'Vic Viewer', callerSub, 12),
      ],
    },
    {
      id: JUNIPER_ID, name: 'Juniper Trail Co.', slug: 'juniper', status: 'active', created_at: daysAgo(20), secret_status: 'pending',
      members: [
        member(subOf('editor-demo'), 'admin', 'editor@example.com', 'Eddie Editor', '', 20),
        member(callerSub, 'editor', 'admin@example.com', 'Ada Admin', subOf('editor-demo'), 8),
      ],
    },
  ];
}

const byName = (a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }) || a.id.localeCompare(b.id);
const roleOf = (workspace, sub) => workspace.members.find((member) => member.sub === sub)?.role ?? null;

function isPlatformAdmin(shared) {
  return state.platformAdmin && shared.mockUsers.some((user) => user.username === shared.mockCaller.username && user.enabled && user.groups.includes(PLATFORM_ADMIN_GROUP));
}

/** `GET /me/workspaces`: the caller's memberships, by name, each with its own row's role. */
function myWorkspaces(shared) {
  const sub = shared.mockCaller.sub;
  return state.workspaces.filter((workspace) => roleOf(workspace, sub) !== null).sort(byName)
    .map((workspace) => ({ id: workspace.id, name: workspace.name, slug: workspace.slug, role: roleOf(workspace, sub) }));
}

/** The workspace X-Workspace-Id names as the caller may act in it, or [status, error] (resolve_workspace). */
function resolve(req, shared) {
  const header = req.headers['x-workspace-id'];
  if (typeof header !== 'string' || header === '') return { refusal: [400, 'The X-Workspace-Id header is required'] };
  const workspace = state.workspaces.find((candidate) => candidate.id === header && candidate.status === 'active');
  const own = workspace === undefined ? null : roleOf(workspace, shared.mockCaller.sub);
  if (workspace !== undefined && own !== null) return { workspace, role: own, platformAdmin: false };
  // A platform admin who is not a member enters as admin (audited by the server).
  if (workspace !== undefined && isPlatformAdmin(shared)) return { workspace, role: 'admin', platformAdmin: true };
  return { refusal: [404, NOT_FOUND] };
}

/** A member as the list answers it: an empty email or name filled from the mock's users, like Cognito by sub. */
function listed(member, shared) {
  if (member.email !== '') return member;
  const user = shared.mockUsers.find((candidate) => shared.mockSub(candidate.username) === member.sub);
  return user === undefined ? member : { ...member, email: user.email, name: member.name || user.name };
}

/** One page of `rows` from `?cursor=` (an offset the mock hands out) and `?limit=`; null for a bad one. */
function page(rows, url) {
  const limitText = url.searchParams.get('limit');
  const limit = limitText === null ? DEFAULT_LIMIT : Number(limitText);
  const cursorText = url.searchParams.get('cursor');
  const start = cursorText === null ? 0 : Number(cursorText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(start) || start < 0) return null;
  const end = start + limit;
  return { rows: rows.slice(start, end), next: end < rows.length ? String(end) : null };
}

function listMembers(workspace, url, send, shared) {
  const rows = [...workspace.members].sort((a, b) => a.sub.localeCompare(b.sub)).map((member) => listed(member, shared));
  const found = page(rows, url);
  if (found === null) return send(400, { success: false, error: 'limit or cursor is not valid' });
  return send(200, { members: found.rows, next_cursor: found.next });
}

/** The add's account: the mock user with that email, a 409 for one spelt otherwise, else a new account. */
function accountFor(email, shared) {
  const exact = shared.mockUsers.find((user) => user.email === email);
  if (exact !== undefined) return { sub: shared.mockSub(exact.username), email: exact.email, name: exact.name, account: 'existing' };
  if (shared.mockUsers.some((user) => user.email.toLowerCase() === email.toLowerCase())) return { refusal: [409, EMAIL_ELSEWHERE] };
  // The mock caller is in `admins`, so it may create one (a workspace admin outside `admins` gets 403 from the server).
  state.created += 1;
  return { sub: `sub-new-member-${state.created}`, email, name: '', account: 'created' };
}

/** One `@`, a local part, and a dotted domain with no empty label, no whitespace (the server's rule is stricter). */
function isEmailShape(email) {
  const [local = '', domain = '', ...rest] = email.split('@');
  const labels = domain.split('.');
  return rest.length === 0 && local !== '' && labels.length > 1 && labels.every((label) => label !== '') && !/\s/.test(email);
}

function addMember(workspace, body, send, shared) {
  const email = typeof body?.email === 'string' ? body.email.trim() : '';
  if (!isEmailShape(email)) return send(400, { success: false, error: 'email is not a valid address' });
  if (!ROLES.includes(body?.role)) return send(400, { success: false, error: 'role must be "admin", "editor" or "viewer"' });
  const account = accountFor(email, shared);
  if (account.refusal) return send(account.refusal[0], { success: false, error: account.refusal[1] });
  if (roleOf(workspace, account.sub) !== null) return send(409, { success: false, error: ALREADY_MEMBER });
  const member = { sub: account.sub, role: body.role, email: account.email, name: account.name, invited_by: shared.mockCaller.sub, joined_at: new Date().toISOString() };
  workspace.members.push(member);
  return send(201, { member: { ...member, account: account.account } });
}

/** 409 when `sub` is the workspace's only admin (a demotion or a removal of them). */
const isLastAdmin = (workspace, sub) => roleOf(workspace, sub) === 'admin'
  && !workspace.members.some((member) => member.sub !== sub && member.role === 'admin');

function changeRole(workspace, sub, body, send) {
  if (!ROLES.includes(body?.role)) return send(400, { success: false, error: 'role must be "admin", "editor" or "viewer"' });
  const member = workspace.members.find((candidate) => candidate.sub === sub);
  if (member === undefined) return send(404, { success: false, error: MEMBER_NOT_FOUND });
  if (body.role !== 'admin' && isLastAdmin(workspace, sub)) return send(409, { success: false, error: LAST_ADMIN });
  member.role = body.role;
  return send(200, { member: { sub, role: member.role } });
}

function removeMember(workspace, sub, send) {
  if (roleOf(workspace, sub) === null) return send(404, { success: false, error: MEMBER_NOT_FOUND });
  if (isLastAdmin(workspace, sub)) return send(409, { success: false, error: LAST_ADMIN });
  workspace.members = workspace.members.filter((member) => member.sub !== sub);
  return send(200, { removed: sub });
}

/** The members routes, each in the workspace X-Workspace-Id names; true when the request was taken. */
function handleMembers(req, res, url, send, shared) {
  const target = MEMBER_ROUTE.exec(url.pathname);
  const isList = url.pathname === MEMBERS_ROUTE && (req.method === 'GET' || req.method === 'POST');
  const isOne = target !== null && (req.method === 'PUT' || req.method === 'DELETE');
  if (!isList && !isOne) return false;
  shared.collectJson(req, res, (body) => {
    const entry = resolve(req, shared);
    if (entry.refusal) return send(entry.refusal[0], { success: false, error: entry.refusal[1] });
    const { workspace, role } = entry;
    if (req.method === 'GET') return listMembers(workspace, url, send, shared);
    const sub = target === null ? null : decodeURIComponent(target[1]);
    // Leaving (removing yourself) is for any member; every other write is for the workspace's admins.
    const leaving = req.method === 'DELETE' && sub === shared.mockCaller.sub;
    if (!leaving && role !== 'admin') return send(403, { success: false, error: NOT_WORKSPACE_ADMIN });
    if (req.method === 'POST') return addMember(workspace, body, send, shared);
    return req.method === 'PUT' ? changeRole(workspace, sub, body, send) : removeMember(workspace, sub, send);
  });
  return true;
}

function createWorkspace(body, send, shared) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (name === '' || name.length > NAME_MAX) return send(400, { success: false, error: `name must be 1 to ${NAME_MAX} characters` });
  const slug = body?.slug;
  if (typeof slug !== 'string' || !SLUG.test(slug)) {
    return send(400, { success: false, error: 'slug must be 3 to 40 characters of a-z, 0-9 and "-", not starting or ending with "-"' });
  }
  if (RESERVED_SLUGS.has(slug)) return send(400, { success: false, error: `slug "${slug}" is reserved: choose another` });
  if (!state.enabled) {
    return send(400, { success: false, error: 'The dev mock creates workspaces only after PUT /__mock/workspaces {"enabled": true}' });
  }
  if (state.workspaces.some((workspace) => workspace.slug === slug)) return send(409, { success: false, error: SLUG_TAKEN });
  state.created += 1;
  const id = `ws_01JCNEW${String(state.created).padStart(19, '0')}`;
  const createdAt = new Date().toISOString();
  const creator = { sub: shared.mockCaller.sub, role: 'admin', email: '', name: '', invited_by: '', joined_at: createdAt };
  state.workspaces.push({ id, name, slug, status: 'active', created_at: createdAt, secret_status: 'ready', members: [creator] });
  return send(201, { workspace: { id, name, slug, role: 'admin', secret_status: 'ready' } });
}

/** `GET` and `POST /platform/workspaces`, platform admins only; true when the request was taken. */
function handlePlatform(req, res, url, send, shared) {
  if (url.pathname !== PLATFORM_ROUTE || (req.method !== 'GET' && req.method !== 'POST')) return false;
  shared.collectJson(req, res, (body) => {
    if (!isPlatformAdmin(shared)) return send(403, { success: false, error: NOT_PLATFORM_ADMIN });
    if (req.method === 'POST') return createWorkspace(body, send, shared);
    const rows = [...state.workspaces].sort(byName)
      .map(({ id, name, slug, status, created_at, secret_status }) => ({ id, name, slug, status, created_at, secret_status }));
    const found = page(rows, url);
    if (found === null) return send(400, { success: false, error: 'limit or cursor is not valid' });
    return send(200, { workspaces: found.rows, next_cursor: found.next });
  });
  return true;
}

function currentWorkspace(req, send, shared) {
  const entry = resolve(req, shared);
  if (entry.refusal) return send(entry.refusal[0], { success: false, error: entry.refusal[1] });
  const { id, name, slug } = entry.workspace;
  return send(200, { workspace: { id, name, slug, role: entry.role, platform_admin: entry.platformAdmin } });
}

/** The switch's fixtures; with `member` (a slug) the caller keeps only that workspace's membership. */
function switchFixtures(member, shared) {
  const workspaces = fixtures(shared.mockCaller.sub, shared.mockSub);
  if (member === undefined) return workspaces;
  return workspaces.map((workspace) => workspace.slug === member
    ? workspace
    : { ...workspace, members: workspace.members.filter((row) => row.sub !== shared.mockCaller.sub) });
}

/** PUT /__mock/workspaces {enabled, member?}: the dev switch (no other method is served); each call starts afresh. */
function control(req, res, send, shared) {
  shared.collectJson(req, res, (body) => {
    const member = body?.member;
    if (typeof body?.enabled !== 'boolean') {
      send(400, { success: false, error: 'enabled must be true or false' });
      return;
    }
    if (member !== undefined && !body.enabled) {
      send(400, { success: false, error: 'member needs enabled: true' });
      return;
    }
    const workspaces = body.enabled ? switchFixtures(member, shared) : [];
    if (member !== undefined && !workspaces.some((workspace) => workspace.slug === member)) {
      send(400, { success: false, error: 'member must be the slug of a mock workspace (acme, juniper)' });
      return;
    }
    state.enabled = body.enabled;
    state.workspaces = workspaces;
    state.created = 0;
    // `member` also makes the caller no platform admin to these routes; off again restores the default.
    state.platformAdmin = !(body.enabled && member !== undefined);
    send(200, { enabled: state.enabled });
  });
}

/** Handle the workspace, members, platform and `/__mock/workspaces` routes; returns true when the request was taken. */
export function handleWorkspaceRoutes(req, res, url, send, shared) {
  if (url.pathname === CONTROL_ROUTE && req.method === 'PUT') {
    control(req, res, send, shared);
    return true;
  }
  if (handleMembers(req, res, url, send, shared) || handlePlatform(req, res, url, send, shared)) return true;
  if (req.method !== 'GET') return false;
  if (url.pathname === '/me/workspaces') {
    send(200, { workspaces: myWorkspaces(shared) });
    return true;
  }
  if (url.pathname === '/me/workspaces/current') {
    currentWorkspace(req, send, shared);
    return true;
  }
  return false;
}
