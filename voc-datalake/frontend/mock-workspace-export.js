// A workspace's export in the dev mock, in the wire shapes of the API (docs/multi-workspace.md, Export and delete;
// lambda/api/workspaces_handler.py, shared/export_jobs.py), each in the workspace X-Workspace-Id names
// (mock-workspaces.js `resolve`: 400 without the header, one 404 for a workspace the caller cannot enter), for the
// workspace's admins only (403 'Workspace admin access required' for an editor or a viewer):
//   POST /me/workspaces/current/export        → 202 {export: {id, status: 'queued', created_at}}; 409 while another
//        export of the workspace runs
//   GET  /me/workspaces/current/export        → {export: {id, status, created_at, completed_at?, expires_at?, …} | null}
//        (the newest export; the mock's moves queued → running → completed on the reads that follow, so the web app's
//        polling shows each step)
//   POST /me/workspaces/current/export/link   → {link: {id, url, expires_in: 900, expires_at}} for a completed export
//        inside its 7 days, else 409
// The state lives on each mock workspace, so every `PUT /__mock/workspaces` starts it afresh. Wired into
// mock-server.js by handleDomainModules.

import { resolve } from './mock-workspaces.js';

const EXPORT_ROUTE = '/me/workspaces/current/export';
const LINK_ROUTE = '/me/workspaces/current/export/link';
const DAY_MS = 86_400_000;
const LINK_SECONDS = 900;

// The refusals' texts: workspaces_handler.py, workspace.py.
const NOT_WORKSPACE_ADMIN = 'Workspace admin access required';
const EXPORT_ALREADY_RUNNING = 'An export of this workspace is already running: wait for it to finish, then start another';
const EXPORT_NOT_DOWNLOADABLE = 'No export can be downloaded: the newest is not completed, or its 7 days are over. Start a new export';

const refuse = (send, [status, error]) => send(status, { success: false, error });

/** The export as the API shows it, a step further on each read while it is being made. */
function advance(job) {
  if (job.status === 'queued') {
    job.status = 'running';
  } else if (job.status === 'running') {
    const completed = new Date();
    Object.assign(job, { status: 'completed', completed_at: completed.toISOString(),
      expires_at: new Date(completed.getTime() + 7 * DAY_MS).toISOString(), size_bytes: 48_213, counts: { feedback: 12 } });
  }
}

function startExport(workspace, send) {
  const current = workspace.export;
  if (current !== undefined && (current.status === 'queued' || current.status === 'running')) {
    return refuse(send, [409, EXPORT_ALREADY_RUNNING]);
  }
  workspace.exports = (workspace.exports ?? 0) + 1;
  const id = `ex_01JCMOCK${String(workspace.exports).padStart(17, '0')}`;
  workspace.export = { id, status: 'queued', created_at: new Date().toISOString() };
  return send(202, { export: { ...workspace.export } });
}

function exportStatus(workspace, send) {
  const current = workspace.export;
  if (current === undefined) return send(200, { export: null });
  const shown = { ...current };
  advance(current);
  return send(200, { export: shown });
}

function exportLink(workspace, send) {
  const current = workspace.export;
  const now = Date.now();
  if (current?.status !== 'completed' || Date.parse(current.expires_at) <= now) {
    return refuse(send, [409, EXPORT_NOT_DOWNLOADABLE]);
  }
  return send(200, { link: { id: current.id, url: `https://example.com/mock-exports/${current.id}/workspace-export.zip`,
    expires_in: LINK_SECONDS, expires_at: new Date(now + LINK_SECONDS * 1000).toISOString() } });
}

/** The export routes; true when the request was taken. */
export function handleWorkspaceExportRoutes(req, res, url, send, shared) {
  const isExport = url.pathname === EXPORT_ROUTE && (req.method === 'GET' || req.method === 'POST');
  const isLink = url.pathname === LINK_ROUTE && req.method === 'POST';
  if (!isExport && !isLink) return false;
  shared.collectJson(req, res, () => {
    const entry = resolve(req, shared);
    if (entry.refusal) return refuse(send, entry.refusal);
    if (entry.role !== 'admin') return refuse(send, [403, NOT_WORKSPACE_ADMIN]);
    if (isLink) return exportLink(entry.workspace, send);
    return req.method === 'POST' ? startExport(entry.workspace, send) : exportStatus(entry.workspace, send);
  });
  return true;
}
