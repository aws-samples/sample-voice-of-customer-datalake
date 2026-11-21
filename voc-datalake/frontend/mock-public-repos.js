// Any public GitHub repository for the engineering agents (7.57.00): the agents_handler.py routes over the mock's
// connections (mock-engineering-runs.js), in their wire shape, admin only:
//   GET  /agents/engineering/public-repositories?q=   a search of the sample public repositories (a name, owner/name or
//                                                     a github.com address), each with the connection that has it;
//                                                     400 for an empty or too long query
//   POST /agents/engineering/public-connections       {repository, reason?}: 201 {connection, created, issues: null}, a
//                                                     read-only connection (kind public_read); 404 for a private or
//                                                     unknown one, 409 already connected or at the limit
//   POST /agents/engineering/connections/<id>/fork    {account, org?, licence, app_id?, workspace?}: GitHub's fork page
//                                                     and the App's install link (a fork state, mock-github-apps.js);
//                                                     409 archived, no licence, another licence than the upstream's
//   PUT  /agents/engineering/connections/<id>/upstream  {licence, reason?} (7.58.00): a fork connection's owner
//                                                     acknowledges the upstream's current licence again; 409 for
//                                                     anyone but its owner or another licence than the upstream's
// No real GitHub is reached and no token exists here.

import { mintForkState } from './mock-github-apps.js';

const SEARCH_PATH = '/agents/engineering/public-repositories';
const CONNECT_PATH = '/agents/engineering/public-connections';
const CONNECTION_ACTION = /^\/agents\/engineering\/connections\/([^/]+)\/(fork|upstream)$/;
const MAX_QUERY = 200;
const ORG_LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

/** The sample public repositories GitHub's search finds (fictional). */
const PUBLIC_REPOSITORIES = [
  { repository: 'open-tools/lint-kit', description: 'A small, fast linter for configuration files.', stars: 1240,
    licence: { spdx: 'MIT', name: 'MIT License' }, archived: false, pushed_at: daysAgo(2), default_branch: 'main' },
  { repository: 'open-tools/old-cli', description: 'The command line tool before lint-kit.', stars: 310,
    licence: { spdx: 'Apache-2.0', name: 'Apache License 2.0' }, archived: true, pushed_at: daysAgo(900), default_branch: 'master' },
  { repository: 'sample-labs/notes', description: null, stars: 4, licence: null, archived: false, pushed_at: daysAgo(40),
    default_branch: 'main' },
].map((repo) => ({ ...repo, html_url: `https://github.com/${repo.repository}`, fork: false }));


/** The query as a repository name: `owner/name` out of a github.com address, else the text itself. */
function asked(query) {
  const fromUrl = /^https:\/\/github\.com\/([^/]+\/[^/?#]+)/.exec(query);
  return (fromUrl ? fromUrl[1].replace(/\.git$/, '') : query).toLowerCase();
}

function search(url, connections) {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (query === '' || query.length > MAX_QUERY) return [400, { message: `q is 1 to ${MAX_QUERY} characters: a name, owner/name or a GitHub address` }];
  const wanted = asked(query);
  const connectedTo = (repository) => [...connections.values()]
    .find((c) => c.repository.toLowerCase() === repository.toLowerCase())?.connection_id ?? null;
  const repositories = PUBLIC_REPOSITORIES.filter((repo) => repo.repository.toLowerCase().includes(wanted))
    .map((repo) => ({ ...repo, connected: connectedTo(repo.repository) }));
  return [200, { repositories, query }];
}

function publicConnection(repo, appId) {
  const now = new Date().toISOString();
  const id = repo.repository.split('/')[1];
  return {
    connection_id: id, host: 'github', repository: repo.repository, default_branch: repo.default_branch,
    repository_private: false, kind: 'public_read',
    credential: { kind: 'public_read', set: true, app_id: appId, installation_id: '31415926', expires_at: null },
    public: { stars: repo.stars, licence: repo.licence?.spdx ?? null, archived: repo.archived, pushed_at: repo.pushed_at },
    fork: null, created_at: now, created_by: 'admin-demo', updated_at: now, updated_by: 'admin-demo', version: 1,
    ci_attestation: null,
  };
}

function connect(body, connections, limit) {
  const repository = typeof body?.repository === 'string' ? body.repository : '';
  if (Object.keys(body ?? {}).some((key) => !['repository', 'reason'].includes(key))) {
    return [400, { message: 'the body is {repository, reason?}' }];
  }
  const repo = PUBLIC_REPOSITORIES.find((entry) => entry.repository.toLowerCase() === repository.toLowerCase());
  if (repo === undefined) return [404, { message: `${repository || 'that repository'} is not a public repository GitHub has: a private one connects through the App's installation` }];
  if ([...connections.values()].some((c) => c.repository.toLowerCase() === repo.repository.toLowerCase())) {
    return [409, { message: `${repo.repository} is already connected` }];
  }
  if (connections.size >= limit) return [409, { message: `at most ${limit} connections: remove one to add another` }];
  const connection = publicConnection(repo, '271828');
  connections.set(connection.connection_id, connection);
  return [201, { connection, created: true, issues: null }];
}

function fork(connection, body) {
  if (connection.kind !== 'public_read') return [409, { message: 'only a read-only public connection is forked from here' }];
  if (body?.account !== 'user' && body?.account !== 'organization') return [400, { message: 'account is user or organization' }];
  if (body.account === 'organization' && !ORG_LOGIN.test(String(body.org ?? ''))) {
    return [400, { message: 'org is the organization\'s login: letters, digits and single hyphens, at most 39 characters' }];
  }
  if (connection.public?.archived) return [409, { message: `${connection.repository} is archived: it takes no contributions` }];
  const licence = connection.public?.licence ?? null;
  if (licence === null) return [409, { message: `${connection.repository} names no licence: it can't be contributed to here` }];
  if (body.licence !== licence) return [409, { message: `the licence of ${connection.repository} is ${licence}: acknowledge it to contribute` }];
  const appId = typeof body.app_id === 'string' ? body.app_id : '271828';
  const state = mintForkState(appId, connection.repository, connection.connection_id);
  return [200, { fork_url: `https://github.com/${connection.repository}/fork`,
    install_url: `https://github.com/apps/voc-agents-3f9a2c/installations/new?state=${state}`,
    expires_at: new Date(Date.now() + 30 * 60_000).toISOString(), app_id: appId }];
}

function upstream(connection, body) {
  if (connection.kind !== 'fork' || connection.fork === null) return [409, { message: 'this connection is not a fork' }];
  if (!connection.fork.owned_by_me) return [409, { message: `only ${connection.fork.owner}, the connection's owner, changes this` }];
  if (typeof body?.licence !== 'string' || body.licence === '') return [400, { message: 'the body is {licence, reason?}: the upstream\'s current licence' }];
  if (body.licence !== 'MIT') return [409, { message: `${connection.fork.upstream}'s licence is MIT, not the ${body.licence} acknowledged for this connection: acknowledge it again on the connection` }];
  connection.fork = { ...connection.fork, licence: body.licence };
  connection.version += 1;
  connection.updated_at = new Date().toISOString();
  return [200, { connection }];
}

/** The public repositories' routes over the mock's `connections`, or false for another path. */
export function handlePublicRepositoryRoutes(req, res, url, send, shared, { connections, connectionLimit, isAdmin }) {
  const action = CONNECTION_ACTION.exec(url.pathname);
  if (url.pathname !== SEARCH_PATH && url.pathname !== CONNECT_PATH && action === null) return false;
  if (!isAdmin()) {
    send(403, { message: 'Admin access required' });
    return true;
  }
  if (url.pathname === SEARCH_PATH) {
    if (req.method === 'GET') send(...search(url, connections));
    else send(405, { message: 'Method not allowed' });
    return true;
  }
  if (url.pathname === CONNECT_PATH) {
    if (req.method === 'POST') shared.collectJson(req, res, (body) => send(...connect(body, connections, connectionLimit)));
    else send(405, { message: 'Method not allowed' });
    return true;
  }
  connectionAction(req, res, send, shared, connections.get(decodeURIComponent(action[1])), action[2]);
  return true;
}

/** `…/connections/<id>/fork` (POST) and `…/upstream` (PUT) of a stored connection. */
function connectionAction(req, res, send, shared, connection, kind) {
  const steps = { fork: ['POST', fork], upstream: ['PUT', upstream] };
  const [method, step] = steps[kind];
  if (connection === undefined) send(404, { message: 'Connection not found' });
  else if (req.method !== method) send(405, { message: 'Method not allowed' });
  else shared.collectJson(req, res, (body) => send(...step(connection, body)));
}

/** The sample read-only public connection and the sample fork of it (the mock's connections start with both). */
export function sampleContributions() {
  const read = publicConnection(PUBLIC_REPOSITORIES[0], '271828');
  const now = new Date().toISOString();
  const forkConnection = {
    connection_id: 'lint-kit-fork', host: 'github', repository: 'admin-demo/lint-kit', default_branch: 'main',
    repository_private: false, kind: 'fork',
    credential: { kind: 'app_reference', set: true, app_id: '271828', installation_id: '27182818', expires_at: null },
    public: null,
    fork: { upstream: 'open-tools/lint-kit', upstream_connection: 'lint-kit', upstream_default_branch: 'main',
      owner: 'admin-demo', owned_by_me: true, licence: 'MIT', account: 'admin-demo',
      account_type: 'User' },
    created_at: now, created_by: 'admin-demo', updated_at: now, updated_by: 'admin-demo', version: 1, ci_attestation: null,
  };
  return [read, forkConnection];
}
