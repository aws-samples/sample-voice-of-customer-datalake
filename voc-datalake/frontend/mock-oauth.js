// MCP OAuth sign-in mocks (docs/mcp.md "OAuth sign-in"): the consent API and "my sign-ins" under
// /connect/oauth, in the lambda/shared/mcp_oauth_consent_routes.py wire shapes. Stateful for the life
// of the mock process. The anonymous facade (/oauth/*, /.well-known/*) is not mocked: the SPA never
// calls it; only MCP clients do. Wired into mock-server.js beside handleConnectRoutes.

import { credentialStatus, isoIn } from './mock-credentials.js';

/** The mock deployment's MCP clients (kind → id), as MCP_OAUTH_CLIENTS names them. */
const MOCK_OAUTH_CLIENTS = { kiro: 'mock-kiro-client', 'claude-code': 'mock-claude-client', cursor: 'mock-cursor-client' };
const CLIENT_NAMES = { kiro: 'Kiro', 'claude-code': 'Claude Code', cursor: 'Cursor', web: 'Web assistant' };
const LOOPBACK_PATHS = { kiro: '/oauth/callback', 'claude-code': '/callback', cursor: '/callback' };
/**
 * The grant id a new consent gets per client kind, in the real `oag_<40 hex>` shape
 * (shared/mcp_oauth_grants.py derives it from the sub and the client id: one per person and client).
 */
const MOCK_GRANT_IDS = {
  kiro: 'oag_0123456789abcdef0123456789abcdef01234567',
  'claude-code': 'oag_c1a0de00c0de00c1a0de00c0de00c1a0de00c0de',
  cursor: 'oag_fedcba9876543210fedcba9876543210fedcba98',
};
const CONSENT_ROUTE = /^\/connect\/oauth\/consent$/;
const GRANT_ROUTE = /^\/connect\/oauth\/grants(?:\/([^/]+))?$/;

const grants = [
  {
    grant_id: MOCK_GRANT_IDS.kiro, client_kind: 'kiro', client_name: 'Kiro',
    scope: 'write', project_id: null, created_at: isoIn(-3), expires_at: isoIn(87), last_used_at: isoIn(-0.1),
    revoked_at: null, signed_in: true,
  },
  // Sparse legacy-shaped row (no scope, no status): keeps the Zod defaults exercised.
  { grant_id: MOCK_GRANT_IDS.cursor, client_name: 'Cursor', created_at: isoIn(-40) },
];

const view = (grant) => ({ ...grant, status: credentialStatus(grant) });

function kindOf(clientId) {
  return Object.keys(MOCK_OAUTH_CLIENTS).find((kind) => MOCK_OAUTH_CLIENTS[kind] === clientId);
}

/** The authorize request the consent page carries, or an error message (the backend's checks, simplified). */
function parseAuthorize(raw) {
  const params = new URLSearchParams(typeof raw === 'string' ? raw : '');
  const kind = kindOf(params.get('client_id'));
  const redirect = params.get('redirect_uri') ?? '';
  let path = '';
  try {
    const url = new URL(redirect);
    path = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) && url.protocol === 'http:' ? url.pathname : '';
  } catch {
    path = '';
  }
  if (!kind || path !== LOOPBACK_PATHS[kind]) return { error: 'This sign-in request cannot be approved: unknown client or redirect URI' };
  const scope = params.get('scope') ?? '';
  return { kind, redirect, state: params.get('state'), canWrite: scope === '' || scope.includes('/write') };
}

function denyRedirect(request) {
  const back = new URL(request.redirect);
  back.searchParams.set('error', 'access_denied');
  back.searchParams.set('error_description', 'The connection was not approved');
  if (request.state) back.searchParams.set('state', request.state);
  return back.toString();
}

function routeConsent(method, url, body) {
  const request = parseAuthorize(method === 'GET' ? url.searchParams.get('authorize_query') : body?.authorize_query);
  if (request.error) return [400, { success: false, error: request.error }];
  if (method === 'GET') {
    return [200, {
      refused: false, client_kind: request.kind, client_name: CLIENT_NAMES[request.kind], can_write: request.canWrite,
      can_run_agents: true, loopback: true, deny_redirect: denyRedirect(request),
    }];
  }
  if (body?.scope !== 'read' && body?.scope !== 'write') {
    return [400, { success: false, error: 'scope is required and must be one of: read, write' }];
  }
  const grant = grants.find((g) => g.grant_id === MOCK_GRANT_IDS[request.kind]);
  const fresh = {
    grant_id: MOCK_GRANT_IDS[request.kind], client_kind: request.kind,
    client_name: CLIENT_NAMES[request.kind], scope: body.scope, project_id: body.project_id || null,
    created_at: new Date().toISOString(), expires_at: isoIn(90), last_used_at: null, revoked_at: null, signed_in: false,
  };
  if (grant) Object.assign(grant, fresh); else grants.unshift(fresh);
  // The real answer is Cognito's hosted sign-in; the mock sends the browser back to Connect instead.
  return [200, { redirect_to: 'http://localhost:5173/connect?mock_oauth=approved' }];
}

function routeGrants(method, grantId) {
  if (!grantId) return method === 'GET' ? [200, { grants: grants.map(view) }] : null;
  const grant = grants.find((g) => g.grant_id === grantId);
  if (!grant) return [404, { success: false, error: 'Sign-in not found' }];
  if (method !== 'DELETE') return null;
  grant.revoked_at ??= new Date().toISOString();
  grant.signed_in = false;
  return [200, { grant: view(grant) }];
}

/** Handle `/connect/oauth/consent` and `/connect/oauth/grants[/{id}]`; returns true when taken. */
export function handleOAuthRoutes(req, res, url, send, collectJson) {
  const grantMatch = url.pathname.match(GRANT_ROUTE);
  if (!CONSENT_ROUTE.test(url.pathname) && !grantMatch) return false;
  collectJson(req, res, (body) => {
    const result = grantMatch ? routeGrants(req.method, grantMatch[1]) : routeConsent(req.method, url, body);
    const [status, payload] = result ?? [405, { success: false, error: 'Method not allowed' }];
    send(status, payload);
  });
  return true;
}

/** The token list's `oauth` block for this mock deployment. */
export function mockOAuthSummary() {
  return { enabled: true, clients: Object.keys(MOCK_OAUTH_CLIENTS).map((kind) => ({ kind, name: CLIENT_NAMES[kind] })) };
}
