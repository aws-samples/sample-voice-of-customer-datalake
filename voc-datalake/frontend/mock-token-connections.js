// A public repository connected with a person's fine-grained token (7.60.00): the agents_handler.py routes
// (shared/agents_engineering_token_routes.py) over the mock's connections (mock-engineering-runs.js), in their wire
// shape, admin only:
//   POST /agents/engineering/token-connections        {repository, token, only_this_repository: true, default_branch?,
//                                                     connection_id?, reason?}: 201 {connection, created: true}, a
//                                                     `fine_grained` connection (its token never answered: only its
//                                                     login, its expiry and whether the viewer saved it); 400 for a
//                                                     field off the rules (never echoing the token), 409 already
//                                                     connected or at the limit, 422 {error, code} for a token GitHub
//                                                     would refuse (here by its shape alone: classic_token for a
//                                                     ghp_/gho_/ghu_/ghs_/ghr_ token; private_repository for a
//                                                     repository named `…/private-…`, the demo's private one)
//   PUT  /agents/engineering/connections/<id>/token   {token, only_this_repository: true, reason?}: 200 {connection},
//                                                     the token replaced (85 days from today); 404 unknown, 409 not a
//                                                     token connection
// No real GitHub is reached and no token is kept: the mock stores what the server's row would (login, expiry, owner).

const CREATE_PATH = '/agents/engineering/token-connections';
const REPLACE_PATH = /^\/agents\/engineering\/connections\/([^/]+)\/token$/;
const FINE_GRAINED = /^github_pat_\w{20,255}$/;
const OTHER_TOKEN = /^gh[pousr]_/;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const CREATE_FIELDS = ['repository', 'token', 'only_this_repository', 'default_branch', 'connection_id', 'reason'];
const REPLACE_FIELDS = ['token', 'only_this_repository', 'reason'];
const DAY_MS = 86_400_000;
/** The days a saved token lasts here (GitHub's answer says it; the server takes at most 90). */
const SAVED_DAYS = 85;

const dayAhead = (days) => new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);

/** The credential's state as the server answers it: never the token. */
function tokenCredential(days) {
  return {
    kind: 'fine_grained_token', set: true, app_id: '271828', installation_id: '31415926', expires_at: dayAhead(days),
    expires_in_days: days, login: 'admin-demo', saved_by_you: true, owner: 'admin-demo',
  };
}

function tokenConnection(id, repository, days, now = new Date().toISOString()) {
  return {
    connection_id: id, host: 'github', repository, default_branch: 'main', repository_private: false, kind: 'fine_grained',
    credential: tokenCredential(days), public: null, fork: null,
    created_at: now, created_by: 'admin-demo', updated_at: now, updated_by: 'admin-demo', version: 1, ci_attestation: null,
  };
}

/** The sample token connection the mock's connections start with: its token expires in 10 days (the warn chip). */
export function sampleTokenConnection() {
  return tokenConnection('partner-sdk', 'partner-org/sdk', 10, new Date(Date.now() - 80 * DAY_MS).toISOString());
}

/** The 400 or 422 of a body's token and tick, or null when they pass. */
function tokenRefusal(body) {
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (OTHER_TOKEN.test(token)) {
    return [422, { error: 'GitHub says this is not a fine-grained token: make a fine-grained one', code: 'classic_token' }];
  }
  if (!FINE_GRAINED.test(token)) return [400, { message: 'token is a fine-grained personal access token (github_pat_…), pasted whole' }];
  if (body.only_this_repository !== true) {
    return [400, { message: 'only_this_repository is true: confirm the token can reach only this repository' }];
  }
  return null;
}

function create(body, connections, limit) {
  const fields = body && typeof body === 'object' ? body : {};
  if (Object.keys(fields).some((key) => !CREATE_FIELDS.includes(key)) || typeof fields.repository !== 'string'
    || !REPOSITORY.test(fields.repository)) {
    return [400, { message: 'the body is {repository, token, only_this_repository, default_branch?, connection_id?, reason?}' }];
  }
  const refused = tokenRefusal(fields);
  if (refused !== null) return refused;
  const name = fields.repository.toLowerCase();
  if (name.split('/')[1].startsWith('private-')) {
    return [422, { error: `${fields.repository} is private: a token connects only a public repository`, code: 'private_repository' }];
  }
  const same = [...connections.values()].find((c) => c.repository.toLowerCase() === name);
  if (same !== undefined) return [409, { message: `this repository is connected already (as ${same.connection_id})` }];
  if (connections.size >= limit) return [409, { message: `at most ${limit} connections: remove one to add another` }];
  const id = name.replace(/[^a-z0-9-]+/g, '-').slice(0, 63);
  const connection = tokenConnection(id, fields.repository, SAVED_DAYS);
  connections.set(id, connection);
  return [201, { connection, created: true }];
}

function replace(connection, body) {
  if (connection === undefined) return [404, { message: 'Connection not found' }];
  if (connection.kind !== 'fine_grained') return [409, { message: 'this connection takes no token: it is not a token connection' }];
  const fields = body && typeof body === 'object' ? body : {};
  if (Object.keys(fields).some((key) => !REPLACE_FIELDS.includes(key))) {
    return [400, { message: 'the body is {token, only_this_repository, reason?}' }];
  }
  const refused = tokenRefusal(fields);
  if (refused !== null) return refused;
  Object.assign(connection, {
    credential: tokenCredential(SAVED_DAYS), version: connection.version + 1, updated_at: new Date().toISOString(),
    updated_by: 'admin-demo',
  });
  return [200, { connection }];
}

/** The token connections' routes over the mock's `connections`, or false for another path. */
export function handleTokenConnectionRoutes(req, res, url, send, shared, { connections, connectionLimit, isAdmin }) {
  const replacing = REPLACE_PATH.exec(url.pathname);
  if (url.pathname !== CREATE_PATH && replacing === null) return false;
  if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (replacing === null) {
    if (req.method === 'POST') shared.collectJson(req, res, (body) => send(...create(body, connections, connectionLimit)));
    else send(405, { message: 'Method not allowed' });
  } else if (req.method === 'PUT') {
    shared.collectJson(req, res, (body) => send(...replace(connections.get(decodeURIComponent(replacing[1])), body)));
  } else send(405, { message: 'Method not allowed' });
  return true;
}
