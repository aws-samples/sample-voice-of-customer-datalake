// The run requests (7.53.00, "MCP for runs": lambda/engineering/run_requests.py and the request routes of
// lambda/api/agents_handler.py), in their wire shape, for `npm run dev` (the web app's three calls; asking for a run is
// the MCP tool engineering_run_request's alone, so the mock answers no ask):
//   GET  /agents/engineering/requests                   {requests}: newest first, the sample's two waiting and one declined
//   POST /agents/engineering/requests/<id>/confirm      202 {request, run}: the Run now starts (the sample run); 409 once
//                                                       decided, 404 for an unknown id
//   POST /agents/engineering/requests/<id>/decline      200 {request}; 409 once decided
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403, as the server answers. Wired by mock-server.js before the
// run routes, which would read `requests` as a run id.
import { SAMPLE_RUN_ID } from './mock-engineering-runs.js';

const PREFIX = '/agents/engineering/requests';
const DECISION = /^\/agents\/engineering\/requests\/([^/]+)\/(confirm|decline)$/;
const isAdmin = () => process.env.MOCK_AGENTS_NON_ADMIN !== '1';
const HOUR = 3_600_000;
const at = (offset) => new Date(Date.now() + offset).toISOString().replace(/\.\d{3}Z$/, 'Z');

function request(id, fields) {
  return {
    request_id: id, status: 'pending', agent_id: 'ag_b0f1e2d3c4a5', agent_name: 'Bug fixer', issue: null, prd: null,
    note: null, requested_at: at(-HOUR), expires_at: at(23 * HOUR), via: 'mcp:tok_mock_kiro', requested_for: 'mock-admin',
    decided_by: null, decided_at: null, outcome: null, run_id: null, engineering_run_id: null, ...fields,
  };
}

const requests = [
  request('01JDB2000000000000000REQ03', { issue: 42, note: 'The paging bug the support team keeps seeing.' }),
  request('01JDB1000000000000000REQ02', { agent_id: 'ag_fe4b1d2c3a5e', agent_name: 'Feature builder',
    prd: { project_id: 'proj_checkout', document_id: 'prd_saved_carts' }, requested_at: at(-2 * HOUR) }),
  request('01JDB0000000000000000REQ01', { issue: 7, status: 'declined', requested_at: at(-26 * HOUR),
    decided_by: 'mock-admin', decided_at: at(-25 * HOUR) }),
];

function decide(requestId, decision) {
  const found = requests.find((item) => item.request_id === requestId);
  if (found === undefined) return [404, { message: 'Run request not found' }];
  if (found.status !== 'pending') return [409, { message: `this request is ${found.status}: it can no longer be decided` }];
  Object.assign(found, { status: decision === 'confirm' ? 'confirmed' : 'declined', decided_by: 'mock-admin', decided_at: at(0) });
  if (decision === 'decline') return [200, { request: structuredClone(found) }];
  Object.assign(found, { outcome: 'started', run_id: `run_${requestId.slice(-5).toLowerCase()}`, engineering_run_id: SAMPLE_RUN_ID });
  return [202, { request: structuredClone(found), run: { run_id: found.run_id, engineering_run_id: SAMPLE_RUN_ID, status: 'running' } }];
}

function route(method, path) {
  if (path === PREFIX && method === 'GET') return [200, { requests: structuredClone(requests) }];
  const decision = DECISION.exec(path);
  if (decision && method === 'POST') return decide(decodeURIComponent(decision[1]), decision[2]);
  return method === 'GET' || method === 'POST' ? [404, { message: 'Run request not found' }] : [405, { message: 'Method not allowed' }];
}

export function handleEngineeringRunRequestRoutes(req, res, url, send, shared) {
  const path = url.pathname;
  if (path !== PREFIX && !path.startsWith(`${PREFIX}/`)) return false;
  if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (req.method === 'POST') shared.collectJson(req, res, () => send(...route(req.method, path)));
  else send(...route(req.method, path));
  return true;
}
