// What the flow canvas reads of the setup behind its steps (7.52.00 C2; lambda/shared/agents_engineering_registry_routes.py),
// in their wire shapes, for `npm run dev`, from the orchestration bundle the server reads (templates/orchestration/
// bundle.json):
//   GET /agents/engineering/registry?connection=        {month, connection, cards}: every role's card, then one made card
//   GET /agents/engineering/registry/<card>?connection= {card, versions, events}; 404 for no such card
//   GET /agents/engineering/gates?connection=           the packs (steps with their messages, tools, image pins, briefs
//                                                       without their text), the defaults and the stop reasons; with a
//                                                       connection, each pack's recorded tool versions
//   GET /agents/engineering/gates/briefs/<id>           one brief with its text; 404 for none
//   GET /agents/engineering/assertions                  the closed vocabulary of step assertions
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403, as the server answers. Wired into mock-server.js by
// handleDomainModules, before the engineering runs' routes (which would read `registry` or `gates` as a run id).
import { readFileSync } from 'node:fs';

const BUNDLE = JSON.parse(readFileSync(new URL('../templates/orchestration/bundle.json', import.meta.url), 'utf8'));
const isAdmin = () => process.env.MOCK_AGENTS_NON_ADMIN !== '1';
const month = () => new Date().toISOString().slice(0, 7);
const GATE_ROLES = new Set(['gate-runner', 'final-go']);

function roleCard(template, connection) {
  return {
    kind: 'role', id: template.id, base_role: template.id, title: template.id, purpose: template.purpose,
    launchable: template.skill !== null && template.skill !== undefined,
    template: { version: template.version, label: template.label, digest: template.digest },
    skill: {
      source: 'template', label: template.label, connection: null, version: null, status: null, provenance: 'template',
      template_version: template.version, template_newer: template.id === 'fixer',
    },
    model: template.model, tools: template.tools, harness: template.harness, broker_ops: template.broker_ops,
    pending_tools: template.pending_tools, gates: GATE_ROLES.has(template.id) ? { packs: BUNDLE.gates.packs.map((pack) => pack.id) } : null,
    inputs: template.inputs, outputs: template.outputs, caps: template.caps, trust: template.trust, evals: template.evals,
    scorecard: connection ? { label: template.label, runs: 9, pass_rate: 0.89, tasks_done: 8, tasks_failed: 1, needs_human: 0, cost_usd: 3.2, since: null, until: null } : null,
    spend: { month: month(), usd: 3.2, tokens_in: 120000, tokens_out: 9000, microvm_seconds: 640 },
    node: template.skill ? { type: 'agent', data: { title: template.id, params: { role: template.id, skill_version: 'latest' } } } : null,
  };
}

/** A card an administrator made from the fixer's accepted v2 (cards.py card_view). */
const MADE_CARD = {
  kind: 'card', id: 'fixer-careful', version: 2, base_role: 'fixer', title: 'Careful fixer',
  purpose: 'The fixer that runs the whole test suite before it submits.',
  skill: { connection: 'storefront', version: 2, label: 'fixer@storefront/2', provenance: 'person', template_version: 3 },
  model: 'global.anthropic.claude-sonnet-5-5', tools: ['read_file', 'list_files', 'write_file', 'run', 'submit_work', 'finish'],
  harness: 'converse', caps: { max_turns: 150, max_input_tokens: 120000 }, inputs: [], outputs: [], trust: {}, template: null,
  created_by: 'admin-demo', created_at: '2026-11-10T09:00:00+00:00',
  node: { type: 'agent', data: { title: 'Careful fixer', params: { role: 'fixer', skill_version: 'v2', model: 'global.anthropic.claude-sonnet-5-5', card: 'fixer-careful@v2' } } },
};

const cards = (connection) => [...BUNDLE.agents.map((template) => roleCard(template, connection)), MADE_CARD];

const STOPS = [
  ['check_failed', 'A check failed, and the fixes did not make it pass'],
  ['looked_at_nothing', 'The gate looked at nothing: no check covers the repository, or a check found nothing to check'],
  ['own_gate_changed', "The change touches the repository's own gate (scripts/validate.sh)"],
  ['review_blocked', 'A review blocked it: the final go said NO-GO'],
  ['rounds_used_up', 'Blocking findings were left after the last round'],
];

function gates(connection) {
  const packs = BUNDLE.gates.packs.map((pack) => ({
    ...pack,
    steps: pack.steps.map((step) => ({
      ...step,
      messages: [{ status: 'fail', reason: `${step.name} failed (exit <code>)` }],
      looked_at_nothing: step.empty_exit_codes.length || step.expect_output ? 'its output must show that it checked something, else it fails' : null,
    })),
    recorded: connection && pack.id === 'python'
      ? { tool_versions: { ruff: '0.7.2', pytest: '8.4.2' }, run_id: '01JMOCKRUN0000000000000000', at: '2026-11-16T14:02:00+00:00' } : null,
  }));
  return {
    packs, aliases: BUNDLE.gates.aliases, own_gate: BUNDLE.gates.own_gate,
    briefs: BUNDLE.gates.briefs.map(({ id, path, packs: covered, digest, bytes }) => ({ id, path, packs: covered, digest, bytes: bytes ?? 0 })),
    runners: ['final-go', 'gate-runner'], defaults: { runner: 'gate-runner@latest', final_go: 'final-go@latest' },
    stops: STOPS.map(([code, text]) => ({ code, text, text_key: `gates.stops.${code}`, decision: 'loop_exhausted', actions: [] })),
    connection: connection || null,
  };
}

const ROLES = BUNDLE.agents.map((template) => template.id);
const check = (id, asks, args, kinds, onFail = ['block', 'warn']) => ({
  check: id, asks, label_key: `assertions.checks.${id.replace(/\./g, '_')}.label`,
  description_key: `assertions.checks.${id.replace(/\./g, '_')}.description`, args,
  args_schema: { type: 'object', additionalProperties: false, required: args.map((arg) => arg.name), properties: {} },
  kinds, on_fail: onFail,
});
const STEPS = ['agent', 'board'];
const VOCABULARY = {
  checks: [
    check('patch.submitted', 'a patch was submitted', [], STEPS),
    check('patch.touches_tests', 'every submitted patch changes a test', [], STEPS),
    check('patch.max_lines', 'no submitted patch changes more than max lines', [{ name: 'max', type: 'integer', minimum: 1 }], STEPS),
    check('review.no_blocking', 'the role named by "by" wrote no blocking finding', [{ name: 'by', type: 'role' }], STEPS),
    check('tasks.posted', 'at least min tasks were posted for role', [{ name: 'role', type: 'role' }, { name: 'min', type: 'integer', minimum: 1, maximum: 100 }], STEPS),
    check('pr.opened', 'a pull request was opened', [], STEPS),
    check('gate.passed', 'the gate runner and the final go both said GO, on one tree', [], ['quality_gate'], ['block', 'fail_arrow', 'warn']),
    check('gate.pack_checks_ran', 'the gate runner recorded at least one check', [], ['quality_gate'], ['block', 'fail_arrow', 'warn']),
    check('learn.proposals_name_case', 'every coach proposal names an existing eval case', [], ['learn']),
  ],
  on_fail: [
    { id: 'block', means: 'the step does not pass, and the run goes to a person', kinds: null },
    { id: 'fail_arrow', means: "a quality gate takes its fail arrow (a quality gate's assertions only)", kinds: ['quality_gate'] },
    { id: 'warn', means: 'recorded only', kinds: null },
  ],
  default_on_fail: 'block', max: 10, roles: ROLES,
};

const REGISTRY = /^\/agents\/engineering\/registry(?:\/([^/]+))?$/;
const GATES = /^\/agents\/engineering\/gates$/;
const BRIEF = /^\/agents\/engineering\/gates\/briefs\/([^/]+)$/;
const ASSERTIONS = /^\/agents\/engineering\/assertions$/;

function answer(url) {
  const path = url.pathname;
  const connection = url.searchParams.get('connection') ?? '';
  const registry = REGISTRY.exec(path);
  if (registry) {
    if (registry[1] === undefined) return [200, { month: month(), connection, cards: cards(connection) }];
    const found = cards(connection).find((card) => card.id === decodeURIComponent(registry[1]));
    return found ? [200, { card: found, versions: found.kind === 'card' ? [found] : [], events: [] }]
      : [404, { success: false, error: `the Registry has no card ${registry[1]}` }];
  }
  if (GATES.test(path)) return [200, gates(connection)];
  const brief = BRIEF.exec(path);
  if (brief) {
    const found = BUNDLE.gates.briefs.find((each) => each.id === decodeURIComponent(brief[1]));
    return found ? [200, { id: found.id, path: found.path, packs: found.packs, digest: found.digest, bytes: found.bytes ?? 0, text: found.text ?? '' }]
      : [404, { success: false, error: `no gate brief ${brief[1]}` }];
  }
  return [200, VOCABULARY];
}

export function handleFlowSetupRoutes(req, res, url, send) {
  const path = url.pathname;
  if (!REGISTRY.test(path) && !GATES.test(path) && !BRIEF.test(path) && !ASSERTIONS.test(path)) return false;
  if (req.method !== 'GET') send(405, { message: 'Method not allowed' });
  else if (!isAdmin()) send(403, { message: 'Admin access required' });
  else send(...answer(url));
  return true;
}
