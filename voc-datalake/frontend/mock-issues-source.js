// The deployment's GitHub Issues source as the repository connections drive it (7.50.02; agents_handler.py,
// lambda/engineering/connectors/issues_sync.py), in its wire shape, admin only, over the mock's `connections`
// (mock-engineering-runs.js):
//   GET /agents/engineering/issues-source            {deployed, signs_in, app_id, repositories, managed, schedule, label,
//                                                     connections: [{connection_id, repository, read, reading, reason,
//                                                     label}]}: the sample App's connections are read, each with its
//                                                     voc-agent label; a connection with a pasted key is `not_app`
//   PUT /agents/engineering/connections/<id>/issues  {read: boolean}: the connection's switch, answered with the view;
//                                                     404 for an unknown connection, 409 to read one that is not the App's
// and the `issues` block the installation's and Check installation's answers carry (mock-github-apps.js).

const ISSUES_PATH = '/agents/engineering/issues-source';
const SWITCH_PATH = /^\/agents\/engineering\/connections\/([^/]+)\/issues$/;
/** The source signs in with the sample App (mock-github-apps.js). */
const SOURCE_APP = '271828';
const LABEL = 'voc-agent';
/** connection id -> its switch (absent: on). */
const switches = new Map();

const throughApp = (connection) => connection.host === 'github' && connection.credential.kind === 'app_reference';

function connectionIssues(connection) {
  const read = switches.get(connection.connection_id) ?? true;
  if (!throughApp(connection)) {
    return { connection_id: connection.connection_id, repository: connection.repository, read, reading: false, reason: 'not_app', label: null };
  }
  let reason = null;
  if (!read) reason = 'off';
  else if (connection.credential.app_id !== SOURCE_APP) reason = 'other_app';
  return {
    connection_id: connection.connection_id, repository: connection.repository, read, reading: reason === null, reason,
    label: reason === null ? 'created' : null,
  };
}

function view(connections) {
  const entries = [...connections.values()].map(connectionIssues);
  const reading = entries.filter((entry) => entry.reading).map((entry) => entry.repository);
  return {
    deployed: true, signs_in: 'app', app_id: SOURCE_APP, repositories: reading, managed: reading, schedule: 'on', label: LABEL,
    connections: entries,
  };
}

/** What followed for the source from an installation or a check of `appId`'s connections. */
export function issuesFollow(connections, appId) {
  const entries = [...connections.values()].filter((c) => throughApp(c) && c.credential.app_id === appId).map(connectionIssues);
  return {
    signs_in: 'app', added: [], reading: entries.filter((e) => e.reading).map((e) => e.repository),
    skipped: entries.filter((e) => !e.reading).map((e) => ({ repository: e.repository, reason: e.reason })),
    labels: entries.filter((e) => e.reading).map((e) => ({ repository: e.repository, state: 'created' })),
    schedule: 'on', error: null,
  };
}

function setRead(id, body, connections) {
  const connection = connections.get(id);
  if (connection === undefined) return [404, { message: 'Connection not found' }];
  if (body === null || typeof body !== 'object' || Object.keys(body).join() !== 'read' || typeof body.read !== 'boolean') {
    return [400, { message: 'the body is {read: true | false}' }];
  }
  if (body.read && !throughApp(connection)) {
    return [409, { message: 'only a connection made through the deployment\'s GitHub App has its issues read automatically' }];
  }
  switches.set(id, body.read);
  return [200, view(connections)];
}

/** The issues-source routes, or false for another path. */
export function handleIssuesSourceRoutes(req, res, url, send, shared, { connections, isAdmin }) {
  const switchPath = SWITCH_PATH.exec(url.pathname);
  if (url.pathname !== ISSUES_PATH && !switchPath) return false;
  if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (!switchPath) {
    if (req.method === 'GET') send(200, view(connections));
    else send(405, { message: 'Method not allowed' });
  } else if (req.method !== 'PUT') send(405, { message: 'Method not allowed' });
  else shared.collectJson(req, res, (body) => send(...setRead(decodeURIComponent(switchPath[1]), body, connections)));
  return true;
}
