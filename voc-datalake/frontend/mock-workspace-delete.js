// A workspace's delete in the dev mock, in the wire shapes of the API (docs/multi-workspace.md, Export and delete;
// lambda/api/workspaces_handler.py, shared/workspace_deletes.py), in the workspace X-Workspace-Id names:
//   POST /me/workspaces/current/delete  {confirm_slug, legal_basis} → 202 {delete: {job_id, workspace_id,
//        status: 'waiting', phase: 'fence', requested_at, deleting_at, fence_at, progress_at, counts}}
// In the server's order: the body (400: an unknown field, no confirm_slug, a legal basis that is blank, over 300
// characters or holds an email or a phone number), then the workspace (mock-workspaces.js `resolve`: 400 without the
// header, the one 404 for a workspace the caller cannot enter), its admins only (403), the slug typed exactly (400),
// and no export of the workspace running (409, its state from mock-workspace-export.js). Then the workspace reads
// `deleting`: every route of it answers the one 404 at once, while `GET /me/workspaces` still lists it, as on the
// server until the job removes its rows (the mock runs no job: `PUT /__mock/workspaces` starts afresh). The mock
// always offers the delete; a deployment without `-c workspaceHardDelete=true` answers 403 'Deleting a workspace is
// not available in this deployment' and the web app hides it (config.json `features.workspaceDelete`). Wired into
// mock-server.js by handleDomainModules.

import { legalBasisError } from './mock-legal-basis.js';
import { resolve } from './mock-workspaces.js';

const DELETE_ROUTE = '/me/workspaces/current/delete';
/** workspace_deletes.py FENCE: the job begins deleting 21 minutes after the request. */
const FENCE_MS = 21 * 60_000;

// The refusals' texts: workspace_deletes.py, workspace.py.
const NOT_WORKSPACE_ADMIN = 'Workspace admin access required';
const SLUG_MISMATCH = "Type the workspace's slug exactly to confirm the delete";
const SLUG_REQUIRED = "confirm_slug is required: type the workspace's slug";
const EXPORT_RUNNING = 'An export of this workspace is running: wait for it to finish, then delete the workspace';

const refuse = (send, [status, error]) => send(status, { success: false, error });

/** The 400 of a delete's body (workspace_deletes.py `parse_delete_request`), or null. */
function bodyRefusal(body) {
  const unknown = Object.keys(body ?? {}).filter((field) => field !== 'confirm_slug' && field !== 'legal_basis').sort();
  if (unknown.length > 0) return `Unknown field(s): ${unknown.join(', ')}`;
  const slug = body?.confirm_slug;
  if (typeof slug !== 'string' || slug === '') return SLUG_REQUIRED;
  return legalBasisError(body?.legal_basis);
}

function requestDelete(workspace, body, send) {
  if (body.confirm_slug !== workspace.slug) return refuse(send, [400, SLUG_MISMATCH]);
  const running = workspace.export?.status === 'queued' || workspace.export?.status === 'running';
  if (running) return refuse(send, [409, EXPORT_RUNNING]);
  const now = new Date();
  const at = now.toISOString();
  workspace.status = 'deleting';
  return send(202, { delete: {
    job_id: workspace.id, workspace_id: workspace.id, status: 'waiting', phase: 'fence', requested_at: at,
    deleting_at: at, fence_at: new Date(now.getTime() + FENCE_MS).toISOString(), progress_at: at, counts: {},
  } });
}

/** The delete route; true when the request was taken. */
export function handleWorkspaceDeleteRoutes(req, res, url, send, shared) {
  if (url.pathname !== DELETE_ROUTE || req.method !== 'POST') return false;
  shared.collectJson(req, res, (body) => {
    const refusal = bodyRefusal(body);
    if (refusal !== null) return refuse(send, [400, refusal]);
    const entry = resolve(req, shared);
    if (entry.refusal) return refuse(send, entry.refusal);
    if (entry.role !== 'admin') return refuse(send, [403, NOT_WORKSPACE_ADMIN]);
    return requestDelete(entry.workspace, body, send);
  });
  return true;
}
