// The deployment's GitHub Apps (7.45.00, Agents → Connections → Connect GitHub): the `/agents/engineering/github-apps`
// routes of agents_handler.py (lambda/engineering/connectors/github_apps.py) in their wire shape, admin only:
//   GET    /agents/engineering/github-apps                {apps, limit: 5}; each App's `connections` are the ids of the
//                                                         connections whose credential is a reference to it
//   POST   …/github-apps/manifest        {account: user | organization, org?, workspace?}: the form github.com takes (action_url
//                                        with a single-use state, the manifest); 400 for a bad org login, 409 at 5 Apps
//   POST   …/github-apps/conversions     {code, state}: 201 {app, install_url, expires_at}; one uniform 400 for a state
//                                        that is unknown, used or of another purpose; 409 for the code `expired` (GitHub
//                                        refusing it: the App may exist there without its key here)
//   POST   …/github-apps/<app_id>/install    {}: a new install link; 404 for an unknown App
//   POST   …/github-apps/installations   {installation_id, setup_action: install | update, state}: a connection for
//                                        each of the sample installation's repositories (an archived one, one already
//                                        connected and one past the limit skipped); the uniform 400 for the state
//   POST   …/github-apps/<app_id>/check      {}: the repositories its installation covers, and its connections it no
//                                        longer covers (none here)
//   DELETE …/github-apps/<app_id>        {reason?}: {removed: true}; 409 while connections use it; 404
// The installation's and the check's answers carry `issues` (7.50.02): what followed for the deployment's GitHub Issues
// source (mock-issues-source.js).
// No real GitHub is reached: to see the return pages by hand, open
// `/agents/connections/github/created?code=demo-code&state=demo-create-state` and
// `/agents/connections/github/installed?installation_id=31415926&setup_action=install&state=demo-install-state`
// (each demo state is good once per mock run, like a real one).

import { issuesFollow } from './mock-issues-source.js';

const APPS_PATH = /^\/agents\/engineering\/github-apps(?:\/([^/]+))?(?:\/(install|check))?$/;
const APP_LIMIT = 5;
const ORG_LOGIN = /^[A-Za-z0-9](?:-?[A-Za-z0-9]){0,38}$/;
/** A workspace's slug (lambda/shared/platform_workspaces.py `_SLUG`): where the creation's return comes back to. */
const WORKSPACE_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
const APP_ID = /^[1-9]\d{0,19}$/;
const STATE_REFUSED = 'this link is not valid any more (expired, already used or not yours): start again from Agents → Connections';
const CODE_REFUSED = 'GitHub refused the code (it expired or was used): the App may exist on GitHub without its key here. '
  + 'Delete it in GitHub\'s settings (Developer settings → GitHub Apps) and start again.';
/** The sample installation's repositories, as GitHub lists them. */
const INSTALLED_REPOSITORIES = [
  { repository: 'example-org/payments', private: true, archived: false, default_branch: 'main' },
  { repository: 'example-org/storefront', private: true, archived: false, default_branch: 'main' },
  { repository: 'example-org/old-site', private: false, archived: true, default_branch: 'master' },
];

const thirtyMinutes = () => new Date(Date.now() + 30 * 60_000).toISOString();
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

const apps = new Map([['271828', {
  app_id: '271828', slug: 'voc-agents-3f9a2c', owner: 'example-org', owner_type: 'Organization',
  html_url: 'https://github.com/apps/voc-agents-3f9a2c', webhook: true, created_at: minutesAgo(60 * 24 * 5),
  created_by: 'admin-demo', version: 1,
}]]);
/** state -> {purpose: 'create' | 'install', app_id?, used} */
const states = new Map([
  ['demo-create-state', { purpose: 'create', used: false }],
  ['demo-install-state', { purpose: 'install', app_id: '271828', used: false }],
]);
let nextApp = 314159;
let nextState = 1;

function mintState(purpose, appId) {
  const state = `mock-state-${nextState++}`;
  states.set(state, { purpose, app_id: appId, used: false });
  return state;
}

/** Claim `state` for `purpose` once: its record, or null (the uniform refusal). */
function claim(state, purpose) {
  const found = typeof state === 'string' ? states.get(state) : undefined;
  if (found === undefined || found.used || found.purpose !== purpose) return null;
  found.used = true;
  return found;
}

const installUrl = (app) => `https://github.com/apps/${app.slug}/installations/new?state=${mintState('install', app.app_id)}`;

function appView(app, connections) {
  const using = [...connections.values()]
    .filter((c) => c.credential.kind === 'app_reference' && c.credential.app_id === app.app_id).map((c) => c.connection_id);
  return { ...app, connections: using };
}

function manifest(body) {
  if (apps.size >= APP_LIMIT) return [409, { message: `at most ${APP_LIMIT} GitHub Apps: remove one to create another` }];
  const account = body?.account;
  if (account === 'organization' && !ORG_LOGIN.test(String(body.org ?? ''))) {
    return [400, { message: 'org is the organization\'s login: letters, digits and single hyphens, at most 39 characters' }];
  }
  if (account !== 'user' && account !== 'organization') return [400, { message: 'the body is {account: user | organization, org?, workspace?}' }];
  const workspace = body.workspace ?? '';
  if (workspace !== '' && !WORKSPACE_SLUG.test(String(workspace))) return [400, { message: 'workspace is the slug of the workspace the flow started in' }];
  const state = mintState('create');
  const base = account === 'user' ? 'https://github.com/settings/apps/new' : `https://github.com/organizations/${body.org}/settings/apps/new`;
  const hex = (0x3f9a2c + nextState * 4099).toString(16).slice(-4);
  const returnBase = workspace === '' ? 'http://localhost:3000' : `http://localhost:3000/workspace/${workspace}`;
  return [200, {
    action_url: `${base}?state=${state}`, expires_at: thirtyMinutes(),
    manifest: {
      name: `VoC Autonomous Agent ${hex}`, url: 'http://localhost:3000', public: false, request_oauth_on_install: false,
      setup_on_update: true, redirect_url: `${returnBase}/agents/connections/github/created`,
      setup_url: 'http://localhost:3000/agents/connections/github/installed',
      hook_attributes: { url: 'http://localhost:3001/webhooks/github_issues', active: true },
      default_permissions: { contents: 'write', pull_requests: 'write', issues: 'write', metadata: 'read' },
      default_events: ['issues', 'issue_comment'],
    },
  }];
}

function conversion(body, connections) {
  if (claim(body?.state, 'create') === null) return [400, { message: STATE_REFUSED }];
  if (body.code === 'expired') return [409, { message: CODE_REFUSED }];
  const appId = String(nextApp++);
  const app = {
    app_id: appId, slug: `voc-agents-${appId}`, owner: 'admin-demo', owner_type: 'User',
    html_url: `https://github.com/apps/voc-agents-${appId}`, webhook: true, created_at: new Date().toISOString(),
    created_by: 'admin-demo', version: 1,
  };
  apps.set(appId, app);
  return [201, { app: appView(app, connections), install_url: installUrl(app), expires_at: thirtyMinutes() }];
}

function connectionOf(id, { repository, private: isPrivate, default_branch: branch }, app, installationId) {
  const now = new Date().toISOString();
  return {
    connection_id: id, host: 'github', repository, default_branch: branch, repository_private: isPrivate,
    credential: { kind: 'app_reference', set: true, app_id: app.app_id, installation_id: String(installationId), expires_at: null },
    created_at: now, created_by: 'admin-demo', updated_at: now, updated_by: 'admin-demo', version: 1, ci_attestation: null,
  };
}

function installation(body, connections, limit) {
  const id = Number(body?.installation_id);
  if (!Number.isInteger(id) || !APP_ID.test(String(id)) || !['install', 'update'].includes(body?.setup_action)) {
    return [400, { message: 'the body is {installation_id, setup_action: install | update, state}' }];
  }
  const state = claim(body.state, 'install');
  if (state === null) return [400, { message: STATE_REFUSED }];
  const app = apps.get(state.app_id);
  if (app === undefined) return [409, { message: 'the installation belongs to another App' }];
  const saved = [];
  const skipped = [];
  const connected = new Set([...connections.values()].map((c) => c.repository.toLowerCase()));
  for (const repo of INSTALLED_REPOSITORIES) {
    const name = repo.repository.split('/')[1];
    if (repo.archived) skipped.push({ repository: repo.repository, reason: 'archived' });
    else if (connected.has(repo.repository.toLowerCase())) skipped.push({ repository: repo.repository, reason: 'already_connected' });
    else if (connections.size >= limit) skipped.push({ repository: repo.repository, reason: 'limit' });
    else {
      const connectionId = connections.has(name) ? `${name}-2` : name;
      const connection = connectionOf(connectionId, repo, app, id);
      connections.set(connectionId, connection);
      saved.push({ connection, created: true });
    }
  }
  return [200, { app: appView(app, connections), account: { login: 'example-org', type: 'Organization' }, connections: saved, skipped,
    issues: issuesFollow(connections, app.app_id) }];
}

function appRoute(req, send, shared, res, appId, action, connections) {
  const app = apps.get(appId);
  if (app === undefined) return send(404, { message: 'GitHub App not found' });
  if (action === 'install' && req.method === 'POST') return send(200, { install_url: installUrl(app), expires_at: thirtyMinutes() });
  if (action === 'check' && req.method === 'POST') {
    const using = [...connections.values()].filter((c) => c.credential.app_id === appId && c.credential.kind === 'app_reference');
    return send(200, { repositories: [...INSTALLED_REPOSITORIES.map((r) => r.repository)], missing: using
      .filter((c) => !INSTALLED_REPOSITORIES.some((r) => r.repository === c.repository)).map((c) => c.connection_id),
      issues: issuesFollow(connections, appId) });
  }
  if (action !== undefined || req.method !== 'DELETE') return send(405, { message: 'Method not allowed' });
  return shared.collectJson(req, res, () => {
    const view = appView(app, connections);
    if (view.connections.length > 0) {
      return send(409, { message: `${view.connections.length} connection(s) use this App: remove them first` });
    }
    apps.delete(appId);
    return send(200, { removed: true });
  });
}

/** The GitHub Apps routes over the mock's `connections` (mock-engineering-runs.js), or false for another path. */
export function handleGitHubAppRoutes(req, res, url, send, shared, { connections, connectionLimit, isAdmin }) {
  const match = APPS_PATH.exec(url.pathname);
  if (!match) return false;
  if (!isAdmin()) {
    send(403, { message: 'Admin access required' });
    return true;
  }
  const [, first, action] = match;
  if (first === undefined) {
    if (req.method === 'GET') send(200, { apps: [...apps.values()].map((app) => appView(app, connections)), limit: APP_LIMIT });
    else send(405, { message: 'Method not allowed' });
    return true;
  }
  const steps = { manifest: (body) => manifest(body), conversions: (body) => conversion(body, connections),
    installations: (body) => installation(body, connections, connectionLimit) };
  if (action === undefined && Object.hasOwn(steps, first)) {
    if (req.method !== 'POST') send(405, { message: 'Method not allowed' });
    else shared.collectJson(req, res, (body) => send(...steps[first](body)));
    return true;
  }
  appRoute(req, send, shared, res, decodeURIComponent(first), action, connections);
  return true;
}
