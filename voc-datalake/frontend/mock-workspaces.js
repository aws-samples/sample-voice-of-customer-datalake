// Workspaces mock: GET /me/workspaces and GET /me/workspaces/current in the wire shape of
// lambda/api/workspaces_handler.py (docs/multi-workspace.md).
//
// Default: the mock caller is in NO workspace, like every deployment before workspaces, so `npm run dev` and
// the other mock e2e specs open the app as before. To give it workspaces while it runs:
//   curl -X PUT localhost:3001/__mock/workspaces -d '{"enabled":true}'   (false: none again), then reload.
// With workspaces, the caller (admin-demo) is an admin of "Acme Outfitters" (acme) and an editor of
// "Juniper Trail Co." (juniper):
//   GET /me/workspaces          → {workspaces: [{id, name, slug, role}]}, by name
//   GET /me/workspaces/current  → {workspace: {id, name, slug, role, platform_admin}} for the X-Workspace-Id
//                                 header; 400 without it; one 404 for any other id (never "exists").
// Wired into mock-server.js by handleDomainModules; the dev-only /__mock/workspaces route is not an app route.

const CONTROL_ROUTE = '/__mock/workspaces';

/** The caller's memberships, by name (ids in the server's `ws_` + ULID form). */
const MEMBERSHIPS = [
  { id: 'ws_01JCACME0000000000000000A1', name: 'Acme Outfitters', slug: 'acme', role: 'admin' },
  { id: 'ws_01JCJNPR0000000000000000J1', name: 'Juniper Trail Co.', slug: 'juniper', role: 'editor' },
];

const state = { enabled: false };

const myWorkspaces = () => (state.enabled ? MEMBERSHIPS : []);

function currentWorkspace(req, send) {
  const header = req.headers['x-workspace-id'];
  if (typeof header !== 'string' || header === '') {
    send(400, { success: false, error: 'The X-Workspace-Id header is required' });
    return;
  }
  const workspace = myWorkspaces().find((candidate) => candidate.id === header);
  if (workspace === undefined) {
    send(404, { success: false, error: 'Workspace not found' });
    return;
  }
  send(200, { workspace: { ...workspace, platform_admin: false } });
}

/** PUT /__mock/workspaces {enabled}: the dev switch (no other method is served). */
function control(req, res, send, shared) {
  shared.collectJson(req, res, (body) => {
    if (typeof body?.enabled !== 'boolean') {
      send(400, { success: false, error: 'enabled must be true or false' });
      return;
    }
    state.enabled = body.enabled;
    send(200, { enabled: state.enabled });
  });
}

/** Handle `/me/workspaces[/current]` and `/__mock/workspaces`; returns true when the request was taken. */
export function handleWorkspaceRoutes(req, res, url, send, shared) {
  if (url.pathname === CONTROL_ROUTE && req.method === 'PUT') {
    control(req, res, send, shared);
    return true;
  }
  if (req.method !== 'GET') return false;
  if (url.pathname === '/me/workspaces') {
    send(200, { workspaces: myWorkspaces() });
    return true;
  }
  if (url.pathname === '/me/workspaces/current') {
    currentWorkspace(req, send);
    return true;
  }
  return false;
}
