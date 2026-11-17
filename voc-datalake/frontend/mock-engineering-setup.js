// The engineering setup guide's progress and the engineering automations' readiness (7.50.00), in their wire shape,
// for `npm run dev`:
//   GET /agents/engineering/setup                      {steps, intro, revision, updated_at, updated_by}
//   PUT /agents/engineering/setup {revision, steps?, intro?}   the same, as saved (409 once the revision moved)
//     (lambda/shared/agents_engineering_setup_routes.py)
//   GET /agents/engineering/readiness?automation=<agent id>|flow=<template id>[&connection=<id>&language=<language>]
//     {subject, ready, checks: [{id, status: pass | fail | warn | unknown, detail, fix, docs, required}]}
//     (the server's readiness checks, item B of 7.50.00: this fixture follows its shape and its check ids; 7.50.01's
//     `connection` and `language` answer for the agent as if set up with them, 400 for a connection not stored or a
//     language with no image)
// and the 409 `{error, checks}` an engineering agent's Enable answers while a required check does not pass
// (`readinessRefusal`, called by mock-server.js's enable route).
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403, as the server answers. MOCK_ENGINEERING_DIAL=human makes
// the enabling administrator human-driven (no stored way of working): the `dial` check fails and links to Users.
// MOCK_ENGINEERING_SETUP=done starts the guide with every step chosen (a deployment past it).

const STEP_IDS = ['prerequisites', 'understand', 'tenets', 'triage', 'bug_fixer', 'feature_builder', 'ready'];
const STEP_STATES = ['pending', 'skipped', 'done'];
const INTROS = ['started', 'skipped'];
const isAdmin = () => process.env.MOCK_AGENTS_NON_ADMIN !== '1';
const CHANGED = 'the setup guide changed since you opened it: read it again';

const blankSteps = () => Object.fromEntries(STEP_IDS.map((step) => [step, 'pending']));
const progress = process.env.MOCK_ENGINEERING_SETUP === 'done'
  ? { steps: { ...blankSteps(), understand: 'skipped', tenets: 'skipped', ready: 'done' }, intro: 'started', revision: 3,
    updated_at: new Date(Date.now() - 86_400_000).toISOString(), updated_by: 'admin-demo' }
  : { steps: blankSteps(), intro: 'unseen', revision: 0, updated_at: null, updated_by: null };

function changeError(body) {
  const keys = Object.keys(body ?? {});
  if (!keys.every((key) => ['revision', 'steps', 'intro'].includes(key)) || !('revision' in body)) {
    return 'the body is {revision: <the revision read>, steps?: {<step>: pending | skipped | done}, intro?: started | skipped}';
  }
  if (!Number.isInteger(body.revision) || body.revision < 0) return 'revision is the whole number the guide read (0 for a guide never saved)';
  const steps = body.steps ?? {};
  if (typeof steps !== 'object' || Array.isArray(steps) || steps === null) return 'steps is an object of step states';
  const unknown = Object.keys(steps).filter((step) => !STEP_IDS.includes(step));
  if (unknown.length) return `steps are ${STEP_IDS.join(', ')}: not ${unknown.join(', ')}`;
  if (!Object.values(steps).every((state) => STEP_STATES.includes(state))) return `a step is ${STEP_STATES.join(' | ')}`;
  if (body.intro !== undefined && !INTROS.includes(body.intro)) return 'intro is started or skipped';
  if (Object.keys(steps).length === 0 && body.intro === undefined) return 'name the steps to change or the intro to set';
  return null;
}

function saveProgress(body) {
  const error = changeError(body);
  if (error) return [400, { success: false, error }];
  if (body.revision !== progress.revision) return [409, { success: false, error: CHANGED }];
  Object.assign(progress, {
    steps: { ...progress.steps, ...(body.steps ?? {}) }, intro: body.intro ?? progress.intro, revision: progress.revision + 1,
    updated_at: new Date().toISOString(), updated_by: 'admin-demo',
  });
  return [200, structuredClone(progress)];
}

// ── Readiness ──
const DOCS = 'docs/autonomous-engineering.md#readiness-75000';
/** What a run truly needs (the server's required checks): Enable is refused while one of them does not pass. */
const REQUIRED = new Set(['connection', 'ci_attestation', 'image', 'bedrock_models', 'budget', 'dial']);
const check = (id, status, detail, fix = '', docs = DOCS) => ({ id, status, detail, fix, docs, required: REQUIRED.has(id) });
const ATTESTED = new Set(['storefront']);
const NOT_READY = 'the agent is not ready to run: fix the failing checks first (GET /agents/engineering/readiness)';

/** The checks of one engineering agent, from what the mock stores of it (its connection, language and flow), in
 * the server's order. */
function agentChecks(agent, budgetOf) {
  const { connection, language } = agent.engineering;
  const human = process.env.MOCK_ENGINEERING_DIAL === 'human';
  const checks = [
    connection
      ? check('connection', 'pass', `The repository connection ${connection} is stored.`)
      : check('connection', 'fail', 'No repository connection is stored for this automation.',
        'Set it up: pick the repository connection it works on.', 'docs/autonomous-agents.md#engineering-agents'),
    check('app_installation', 'pass', 'The deployment’s GitHub App is installed on example-org/storefront.'),
    connection && !ATTESTED.has(connection)
      ? check('ci_attestation', 'fail', `The CI of ${connection} is not attested.`,
        'Attest the CI points on the connection in Agents → Connections.', 'docs/autonomous-engineering.md#repository-connectors')
      : check('ci_attestation', 'pass', 'The CI of example-org/storefront is attested (version 1).'),
    check('ci_protection', 'unknown', 'The broker reads the branch rules with the connection’s own token at each push.',
      'Protect the default branch with its required checks, and leave voc-agent/* unprotected.'),
    language
      ? check('image', 'pass', `The ${language} image is pushed with its gate packs.`)
      : check('image', 'fail', 'No language is set, so no image can run it.', 'Set it up: pick the repository’s language.'),
    check('pack', 'pass', 'The flow needs no knowledge pack.'),
    check('tenets', 'pass', 'The flow needs no tenets.'),
    check('issues_source', 'pass', 'The GitHub Issues source lists example-org/storefront and signs in with the App.',
      '', 'docs/github-issues.md'),
    check('issue_label', 'unknown', 'The trigger’s label is voc-agent; whether it exists on the repository is not read here.',
      'Create the label, and let only maintainers put it on an issue.', 'docs/github-issues.md'),
    human
      ? check('dial', 'fail', 'The runs follow admin-demo, whose way of working is Human-driven, so a run would push nothing. This flow needs AI-assisted or AI-driven.',
        'An administrator sets the way of working of admin-demo to AI-assisted or AI-driven in Administration → People; with AI-assisted, each push waits for a person’s go on the run.', 'docs/ways-of-working.md')
      : check('dial', 'pass', 'The runs follow admin-demo, whose way of working is AI-driven, which this flow runs in.'),
    budgetOf(agent) === null
      ? check('budget', 'fail', 'Its flow has no monthly budget.', 'Set it up: give its flow a monthly budget.')
      : check('budget', 'pass', `Its flow’s monthly budget is $${budgetOf(agent)}.`),
    check('hard_cap', 'warn', 'The hard cap is off: runs of one flow at once may together pass its budget.',
      'Turn the hard cap on in Agents → Spend.'),
    check('bedrock_models', 'pass', 'Every model of the flow’s agents answers in this Region.'),
    check('agentcore_quota', 'warn', 'The session quota is 10 at once: runs of several flows together may wait.',
      'Ask for a higher AgentCore sessions quota, or a lower setting.', 'docs/deployment.md'),
    check('memory_setting', 'pass', 'The build sessions use the default size.'),
    check('network', 'pass', 'The sessions run in the private subnets named.'),
    check('session_storage', 'pass', 'The workspace bucket took the create-only probe and refused its overwrite.'),
  ];
  return checks;
}

let bound = { agent: () => undefined, budgetOf: () => null, connectionStored: () => false };

/** mock-server.js's agents: one by id, the monthly budget of its flow, and whether a connection is stored. */
export function bindSetupAgents(lookups) {
  bound = lookups;
}

const IMAGE_LANGUAGES = ['java', 'node', 'python', 'rust'];

/** The preview's 400, as the server's (readiness.preview), or null. */
function previewError(connection, language) {
  if (language && !IMAGE_LANGUAGES.includes(language)) return `language is one of ${IMAGE_LANGUAGES.join(', ')}`;
  if (connection && !bound.connectionStored(connection)) return 'connection names no stored repository connection (Agents → Connections)';
  return null;
}

function readiness(url) {
  const automation = url.searchParams.get('automation');
  const flow = url.searchParams.get('flow');
  if ((automation === null) === (flow === null)) return [400, { success: false, error: 'name automation=<agent id> or flow=<template id>' }];
  const connection = url.searchParams.get('connection') ?? '';
  const language = url.searchParams.get('language') ?? '';
  const refused = previewError(connection, language);
  if (refused) return [400, { success: false, error: refused }];
  if (flow !== null) {
    const checks = [check('connection', 'fail', 'No connection is named to ask about.', 'Name the connection the flow runs on.'),
      check('dial', 'pass', 'Your way of working is AI-driven.')];
    return [200, { subject: { kind: 'flow', id: flow, name: flow, connection: null, language: null },
      ready: !checks.some(blocking), checks }];
  }
  const stored = bound.agent(automation);
  if (!stored || stored.status === 'archived' || !stored.engineering) return [404, { success: false, error: 'Agent not found' }];
  // (read-only: the agent as if set up with the selection, nothing saved)
  const agent = { ...stored, engineering: { ...stored.engineering, connection: connection || stored.engineering.connection,
    language: language || stored.engineering.language } };
  const checks = agentChecks(agent, bound.budgetOf);
  return [200, { subject: { kind: 'automation', id: agent.agent_id, name: agent.name,
    connection: agent.engineering.connection, language: agent.engineering.language }, ready: !checks.some(blocking), checks }];
}

/** A required check that does not pass (an unknown one included): Enable waits for it. */
const blocking = (entry) => entry.required && entry.status !== 'pass';

/** The 409 an engineering agent's Enable answers while a required check does not pass, else null. */
export function readinessRefusal(agent) {
  const failing = agentChecks(agent, bound.budgetOf).filter(blocking);
  return failing.length === 0 ? null : [409, { success: false, error: NOT_READY, checks: failing }];
}

const SETUP_PATH = '/agents/engineering/setup';
const READINESS_PATH = '/agents/engineering/readiness';

export function handleEngineeringSetupRoutes(req, res, url, send, shared) {
  const path = url.pathname;
  if (path !== SETUP_PATH && path !== READINESS_PATH) return false;
  if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (path === READINESS_PATH) send(...(req.method === 'GET' ? readiness(url) : [405, { message: 'Method not allowed' }]));
  else if (req.method === 'GET') send(200, structuredClone(progress));
  else if (req.method === 'PUT') shared.collectJson(req, res, (body) => send(...saveProgress(body ?? {})));
  else send(405, { message: 'Method not allowed' });
  return true;
}
