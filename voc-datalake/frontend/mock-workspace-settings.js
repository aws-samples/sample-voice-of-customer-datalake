// A workspace's own settings in the dev mock, in the wire shapes of the API (docs/multi-workspace.md,
// Per-workspace configuration), each in the workspace X-Workspace-Id names (mock-workspaces.js `resolve`: 400
// without the header on the plugins routes, one 404 for a workspace the caller cannot enter):
//   GET  /me/workspaces/current/plugins            → {plugins: [{id, enabled, enabled_at?, enabled_by?}]}, any member
//   PUT  /me/workspaces/current/plugins/{id}       {enabled} → {plugin: {id, enabled, …}}: 404 for a plugin the
//        deployment does not offer, 400 for a bad body, an enable 409 INGESTION_NOT_YET for everyone (before the
//        workspace is resolved), then 403 for a non-admin; a disable answers and changes nothing (no plugin can be
//        enabled yet, so none is)
//   GET  /settings/brand  with X-Workspace-Id     → the workspace's brand (empty until saved), any member
//   PUT  /settings/brand  with X-Workspace-Id     → the workspace's admins only (403 'Workspace admin access required')
// (lambda/api/workspaces_handler.py and shared/workspace_plugin_settings.py; settings_handler.py and
// shared/request_workspace.py `require_settings_admin`). A brand request WITHOUT the header is not taken here: it is
// the deployment's brand in mock-server.js, as on the server, whose save is the deployment's `admins'` (the mock
// caller, admin-demo, is one). The state lives on each mock workspace, so every `PUT /__mock/workspaces` starts it
// afresh. Wired into mock-server.js by handleDomainModules.

import { resolve } from './mock-workspaces.js';

const PLUGINS_ROUTE = '/me/workspaces/current/plugins';
const PLUGIN_ROUTE = /^\/me\/workspaces\/current\/plugins\/([^/]+)$/;
const BRAND_ROUTE = '/settings/brand';

/** The deployment's ceiling: the plugins cdk.context.json enables, in its order (the Lambda's ENABLED_SOURCES). */
const OFFERED = ['webscraper', 'app_reviews_ios', 'app_reviews_android', 's3_import', 'synthetic_reviews', 'github_issues', 'web_reviews'];

// The refusals' texts: workspace_plugin_settings.py, workspace.py.
const INGESTION_NOT_YET = 'Per-workspace ingestion arrives with phase 2 of multi-workspace: a workspace cannot enable a plugin yet';
const PLUGIN_NOT_FOUND = 'Plugin not found';
const NOT_WORKSPACE_ADMIN = 'Workspace admin access required';

const refuse = (send, [status, error]) => send(status, { success: false, error });

/** Every plugin of the ceiling, none enabled: no workspace can enable one yet, so no `PLUGIN#` row exists. */
function listPlugins(send) {
  return send(200, { plugins: OFFERED.map((id) => ({ id, enabled: false })) });
}

/** The body's `enabled`, or the refusal parse_plugin_change makes (400, or the 409 of a held enable). */
function parseChange(body) {
  const extra = body !== null && typeof body === 'object' ? Object.keys(body).filter((key) => key !== 'enabled') : [];
  if (extra.length > 0) return { refusal: [400, `Unknown field: ${extra[0]}`] };
  if (typeof body?.enabled !== 'boolean') return { refusal: [400, 'enabled must be true or false'] };
  if (body.enabled) return { refusal: [409, INGESTION_NOT_YET] };
  return { enabled: false };
}

function changePlugin(req, res, send, shared, pluginId) {
  shared.collectJson(req, res, (body) => {
    // The plugin and the body first, as the server checks them before it resolves the workspace.
    if (!OFFERED.includes(pluginId)) return refuse(send, [404, PLUGIN_NOT_FOUND]);
    const change = parseChange(body);
    if (change.refusal) return refuse(send, change.refusal);
    const entry = resolve(req, shared);
    if (entry.refusal) return refuse(send, entry.refusal);
    if (entry.role !== 'admin') return refuse(send, [403, NOT_WORKSPACE_ADMIN]);
    // Asking for what holds (not enabled) changes and records nothing, as on the server.
    return send(200, { plugin: { id: pluginId, enabled: false } });
  });
}

const EMPTY_BRAND = { brand_name: '', brand_handles: [], hashtags: [], urls_to_track: [] };
const strings = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

function workspaceBrand(req, res, send, shared) {
  shared.collectJson(req, res, (body) => {
    const entry = resolve(req, shared);
    if (entry.refusal) return refuse(send, entry.refusal);
    const { workspace, role } = entry;
    if (req.method === 'GET') return send(200, { ...EMPTY_BRAND, ...workspace.brand });
    if (role !== 'admin') return refuse(send, [403, NOT_WORKSPACE_ADMIN]);
    workspace.brand = {
      brand_name: typeof body?.brand_name === 'string' ? body.brand_name : '',
      brand_handles: strings(body?.brand_handles), hashtags: strings(body?.hashtags), urls_to_track: strings(body?.urls_to_track),
    };
    return send(200, { success: true, message: 'Brand settings saved', settings: { ...workspace.brand } });
  });
}

/** True when X-Workspace-Id names a workspace (a blank one is the deployment, as request_workspace.py reads it). */
const namesWorkspace = (req) => typeof req.headers['x-workspace-id'] === 'string' && req.headers['x-workspace-id'].trim() !== '';

/** Handle the plugins routes and a brand request that names a workspace; true when the request was taken. */
export function handleWorkspaceSettingsRoutes(req, res, url, send, shared) {
  if (url.pathname === BRAND_ROUTE && (req.method === 'GET' || req.method === 'PUT') && namesWorkspace(req)) {
    workspaceBrand(req, res, send, shared);
    return true;
  }
  const target = PLUGIN_ROUTE.exec(url.pathname);
  if (target !== null && req.method === 'PUT') {
    changePlugin(req, res, send, shared, decodeURIComponent(target[1]));
    return true;
  }
  if (url.pathname !== PLUGINS_ROUTE || req.method !== 'GET') return false;
  const entry = resolve(req, shared);
  if (entry.refusal) refuse(send, entry.refusal);
  else listPlugins(send);
  return true;
}
