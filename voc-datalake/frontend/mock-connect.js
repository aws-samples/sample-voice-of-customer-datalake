// Connect page mocks (todofeatures §6.3): personal tokens for the global MCP
// endpoint, in the lambda/api/mcp_tokens_handler.py wire shapes. Stateful for the
// life of the mock process. The mock caller is an admin, so a write token is
// offered run_agent; start with MOCK_AGENTS_NON_ADMIN=1 to see the non-admin form.
// Wired into mock-server.js by handleParameterizedExtras.

import { randomBytes } from 'node:crypto';

const CONNECT_ADMIN = process.env.MOCK_AGENTS_NON_ADMIN !== '1';
const TOKEN_ROUTE = /^\/connect\/tokens(?:\/([^/]+))?$/;
const DAY_MS = 86_400_000;
/** `n` lowercase hex characters (n even), the shape of the real token parts. */
const hex = (n) => randomBytes(n / 2).toString('hex');
const isoIn = (days) => new Date(Date.now() + days * DAY_MS).toISOString();

const tokens = [
  {
    token_id: 'tok_0a1b2c3d4e5f6a7b', name: 'Kiro on my laptop', scope: 'write', project_id: null,
    created_at: isoIn(-12), expires_at: isoIn(18), last_used_at: isoIn(-1), revoked_at: null,
    can_run_agents: CONNECT_ADMIN,
  },
  // Sparse legacy-shaped row (no scope, no status): keeps the Zod defaults exercised.
  { token_id: 'tok_9f8e7d6c5b4a3f2e', name: 'Old Copilot', created_at: isoIn(-60), expires_at: isoIn(-30) },
];
const audits = new Map([
  ['tok_0a1b2c3d4e5f6a7b', [
    { tool: 'search_feedback', at: isoIn(-1), project_id: null, outcome: 'ok' },
    { tool: 'create_document', at: isoIn(-1.1), project_id: 'proj_1', outcome: 'ok' },
    { tool: 'run_agent', at: isoIn(-2), project_id: null, outcome: 'denied' },
  ]],
]);

function statusOf(token) {
  if (token.revoked_at) return 'revoked';
  return token.expires_at && Date.parse(token.expires_at) > Date.now() ? 'active' : 'expired';
}

const view = (token) => ({ ...token, status: statusOf(token) });

function mint(body) {
  const name = typeof body?.name === 'string' ? body.name.trim() : '';
  if (!name) return [400, { success: false, error: 'name is required' }];
  if (body.scope !== 'read' && body.scope !== 'write') {
    return [400, { success: false, error: 'scope is required and must be one of: read, write' }];
  }
  const days = body.expires_in_days ?? 30;
  if (!Number.isInteger(days) || days < 1 || days > 90) {
    return [400, { success: false, error: 'expires_in_days must be an integer between 1 and 90' }];
  }
  const token = {
    token_id: `tok_${hex(16)}`, name, scope: body.scope, project_id: body.project_id || null,
    created_at: new Date().toISOString(), expires_at: isoIn(days), last_used_at: null, revoked_at: null,
    can_run_agents: CONNECT_ADMIN && body.scope === 'write',
  };
  tokens.unshift(token);
  return [200, { token: `voc_${token.token_id}_${hex(64)}`, ...view(token) }];
}

function routeConnect(method, tokenId, body) {
  if (!tokenId) {
    if (method === 'GET') {
      return [200, {
        tokens: tokens.map(view), endpoint_path: '/mcp/global', can_mint_agent_runner: CONNECT_ADMIN,
        limits: { default_expiry_days: 30, max_expiry_days: 90, max_active_tokens: 20 },
      }];
    }
    return method === 'POST' ? mint(body) : null;
  }
  const token = tokens.find((t) => t.token_id === tokenId);
  if (!token) return [404, { success: false, error: 'Token not found' }];
  if (method === 'DELETE') {
    token.revoked_at ??= new Date().toISOString();
    return [200, { token: view(token) }];
  }
  if (method === 'GET') return [200, { token: view(token), events: audits.get(tokenId) ?? [], next_cursor: null }];
  return null;
}

/** Handle `/connect/tokens[/{id}]`; returns true when the request was taken. */
export function handleConnectRoutes(req, res, url, send, collectJson) {
  const match = url.pathname.match(TOKEN_ROUTE);
  if (!match) return false;
  collectJson(req, res, (body) => {
    const result = routeConnect(req.method, match[1], body) ?? [405, { success: false, error: 'Method not allowed' }];
    send(result[0], result[1]);
  });
  return true;
}
