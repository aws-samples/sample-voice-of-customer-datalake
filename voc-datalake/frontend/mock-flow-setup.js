// The assertions' vocabulary the flow canvas's inspectors read (7.52.00 C2; lambda/shared/agents_engineering_registry_routes.py),
// in its wire shape, for `npm run dev`:
//   GET /agents/engineering/assertions                  the closed vocabulary of step assertions
// The Registry, the gates and the briefs are mock-engineering-registry.js's (7.52.00 C3), one mock for both screens.
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403, as the server answers. Wired into mock-server.js by
// handleDomainModules, before the engineering runs' routes (which would read `assertions` as a run id).
import { readFileSync } from 'node:fs';

const BUNDLE = JSON.parse(readFileSync(new URL('../templates/orchestration/bundle.json', import.meta.url), 'utf8'));
const isAdmin = () => process.env.MOCK_AGENTS_NON_ADMIN !== '1';

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

const ASSERTIONS = /^\/agents\/engineering\/assertions$/;

export function handleFlowSetupRoutes(req, res, url, send) {
  if (!ASSERTIONS.test(url.pathname)) return false;
  if (req.method !== 'GET') send(405, { message: 'Method not allowed' });
  else if (!isAdmin()) send(403, { message: 'Admin access required' });
  else send(200, VOCABULARY);
  return true;
}
