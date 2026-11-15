// The engineering agents' skills and scorecards, read only (agents_handler.py's skills routes; lambda/engineering/skills/
// views.py), in their wire shape, for `npm run dev`. Fictional versions of the shared skills and of the sample
// connection `storefront` (mock-engineering-runs.js):
//   GET /agents/engineering/skills?connection=            each role with a version in the scope {connection, roles}
//   GET /agents/engineering/skills/<role>/versions?connection=&page=   its history, newest first, 20 a page
//   GET /agents/engineering/skills/<role>/versions/<n>?connection=     one version, its record and its diff
//   GET /agents/engineering/scorecards/<role>?connection=&versions=    each version's scorecard on a connection
// The server's checks: a role of the catalog, a version from 1, a connection id's shape ('' for the shared skills),
// a page token made for the same history, 1-10 versions each once, scorecards only for a connection (400 otherwise).
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403 on every route, as the server answers.
// Wired into mock-server.js by handleDomainModules, before the engineering runs' routes (which would read `skills`
// as a run id).

const ROLES = ['mapper', 'understander', 'hunter', 'fixer', 'builder', 'committer', 'commit-reviewer', 'gate-runner',
  'pr-author', 'pr-reviewer', 'final-go', 'coordinator', 'coach'];
/** The shipped skills' versions (runtime/harness/skills.py): every role ships version 1 but the coordinator (2) and
 * the coach (none). */
const SHIPPED = Object.fromEntries(ROLES.filter((role) => role !== 'coach').map((role) => [role, role === 'coordinator' ? 2 : 1]));
const CONNECTION = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[1-9]\d{0,5}$/;
const PAGE = 20;
const MAX_COMPARED = 10;
const isAdmin = () => process.env.MOCK_AGENTS_NON_ADMIN !== '1';
const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();

const MODEL = 'global.anthropic.claude-sonnet-5-5';
const TOOLS = ['read_file', 'list_files', 'write_file', 'run', 'report_progress', 'finish'];
const BASE_LINES = ['You are the fixer of an autonomous engineering run.',
  'Plan the smallest fix that makes the failing test pass.',
  'Write the fix and its test in your checkout, then submit your work.'];
const FLAKY = { situation: 'The failing test passes when run again.', action: 'Report it as flaky with both runs; do not change code.' };
const LINT = { situation: 'The linter fails on a file you did not touch.', action: 'Leave it and say so in your summary.' };
const STRICTER = 'Run the package’s whole test suite before you submit.';

const record = (lines, examples) => ({ instructions: lines.join('\n'), examples, tool_policy: TOOLS, model: MODEL, harness: 'converse' });
const noDiff = { instructions: [], examples: [], tools_added: [], tools_removed: [], tools_reordered: false, model: null, harness: null, first: false };
const firstDiff = (lines, examples) => ({
  ...noDiff, instructions: lines.map((line) => ['+', line]), examples: examples.map((e) => ['+', e]),
  tools_added: TOOLS, model: ['', MODEL], harness: ['', 'converse'], first: true,
});
const why = (comment, run = '', failure = '') => ({ run_id: run, failure, comment });
const event = (name, by, at, comment = '') => ({ event: name, by, at, comment });
const measured = (before, after, passed, failureCase, at) => ({
  before, after, passed, gained: passed && failureCase !== '', failure_case: failureCase, cases: 4,
  reasons: [passed ? `${failureCase}, the failure’s case, gained` : 'pagination-review regressed'], by: 'admin-demo', at,
});

function version(n, fields) {
  return {
    version: n, status: 'accepted', summary: '', why: why(''), proposed_by: 'admin-demo', proposed_by_kind: 'person',
    proposed_at: daysAgo(30 - n), accepted_by: '', accepted_at: '', rejected_by: '', rejected_at: '', restores: 0,
    base: null, benchmark: { claimed: null, measured: null }, expected_case: '', events: [], made_with: null, ...fields,
  };
}

/** The versions of each scope (oldest first), by scope ('' shared) and role. */
const SCOPES = {
  '': {
    fixer: [
      version(1, {
        summary: 'Fixer skill proposed: v1, its first version', why: why('Seeded from the shipped skill fixer@1.'),
        accepted_by: 'admin-demo', accepted_at: daysAgo(29), events: [event('accepted', 'admin-demo', daysAgo(29))],
        record: record(BASE_LINES, [FLAKY]), diff: firstDiff(BASE_LINES, [FLAKY]),
      }),
      version(2, {
        status: 'rejected', summary: 'Fixer skill proposed: v1 → v2, one more instruction line', base: { shared: true, version: 1 },
        why: why('Ask for the whole suite on every fix.'), rejected_by: 'admin-demo', rejected_at: daysAgo(20),
        benchmark: { claimed: { before: 0.5, after: 0.75 }, measured: null },
        events: [event('rejected', 'admin-demo', daysAgo(20), 'Too slow for small fixes: try it on one connection first.')],
        record: record([...BASE_LINES, STRICTER], [FLAKY]), diff: { ...noDiff, instructions: [['+', STRICTER]] },
      }),
      version(3, {
        summary: 'Fixer skill proposed: v1 → v3, one more example', base: { shared: true, version: 1 },
        why: why('Say how to treat a lint failure outside the change.'), accepted_by: 'admin-demo', accepted_at: daysAgo(10),
        events: [event('accepted', 'admin-demo', daysAgo(10))],
        record: record(BASE_LINES, [FLAKY, LINT]), diff: { ...noDiff, examples: [['+', LINT]] },
      }),
    ],
    coordinator: [
      version(1, {
        summary: 'Run coordinator skill proposed: v1, its first version', why: why('Seeded from the shipped skill coordinator@2.'),
        accepted_by: 'admin-demo', accepted_at: daysAgo(28), events: [event('accepted', 'admin-demo', daysAgo(28))],
        record: { ...record(['You coordinate an engineering run.'], []), tool_policy: ['read_board', 'post_task', 'finish'] },
        diff: firstDiff(['You coordinate an engineering run.'], []),
      }),
    ],
  },
  storefront: {
    fixer: [
      version(1, {
        summary: 'Fixer skill for storefront proposed: shared v3 → v1, one more instruction line', base: { shared: true, version: 3 },
        why: why('The gate caught an untested change.', '01JDA7K3M9Q2R5T8V0W4X6Y1Z3', 'no_go'), proposed_by: 'coach-0',
        proposed_by_kind: 'agent', expected_case: 'slug-cut-bug', made_with: { model: MODEL, prompt: 'coach-prompt/2' },
        accepted_by: 'admin-demo', accepted_at: daysAgo(6),
        benchmark: { claimed: null, measured: measured(0.75, 1, true, 'slug-cut-bug', daysAgo(7)) },
        events: [event('accepted', 'admin-demo', daysAgo(6)), event('benchmarked', 'admin-demo', daysAgo(7))],
        record: record([...BASE_LINES, STRICTER], [FLAKY, LINT]), diff: { ...noDiff, instructions: [['+', STRICTER]] },
      }),
      version(2, {
        status: 'proposed', summary: 'Fixer skill for storefront proposed: v1 → v2, one fewer example', base: { shared: false, version: 1 },
        why: why('A review comment kept repeating.', '01JDA7K3M9Q2R5T8V0W4X6Y1Z4', 'repeated_finding'), proposed_by: 'coach-0',
        proposed_by_kind: 'agent', expected_case: 'pagination-review', made_with: { model: MODEL, prompt: 'coach-prompt/2' },
        benchmark: { claimed: null, measured: measured(1, 0.75, false, 'pagination-review', daysAgo(1)) },
        events: [event('benchmarked', 'admin-demo', daysAgo(1))],
        record: record([...BASE_LINES, STRICTER], [FLAKY]), diff: { ...noDiff, examples: [['-', LINT]] },
      }),
    ],
  },
};

/** Each shipped version's scorecard on `storefront`, by its session label: the sessions run the shipped skills
 * (fixer@1, coordinator@2 and the coordinator@1 it replaced), never the store's versions above, whose numbers would
 * read the same. */
const CARDS = {
  'fixer@1': { runs: 12, tasks_done: 9, tasks_failed: 2, needs_human: 1, reposts: 1, review_rounds: 14, attempts: 15, cost_usd: 6.42, seconds: 9_300 },
  'coordinator@2': { runs: 8, tasks_done: 7, tasks_failed: 0, needs_human: 1, reposts: 0, review_rounds: 2, attempts: 8, cost_usd: 1.18, seconds: 2_100 },
  'coordinator@1': { runs: 5, tasks_done: 3, tasks_failed: 1, needs_human: 1, reposts: 1, review_rounds: 4, attempts: 6, cost_usd: 2.05, seconds: 3_600 },
};
const EMPTY_CARD = { runs: 0, tasks_done: 0, tasks_failed: 0, needs_human: 0, reposts: 0, review_rounds: 0, attempts: 0, cost_usd: 0, seconds: 0 };

/** A version as the history answers it: without its record, its diff and how it was made (the detail's). */
const DETAIL_ONLY = ['record', 'diff', 'made_with'];
const line = (v) => Object.fromEntries(Object.entries(v).filter(([name]) => !DETAIL_ONLY.includes(name)));
const encode = (text) => Buffer.from(text).toString('base64url');

function scopeOf(url) {
  const connection = url.searchParams.get('connection') ?? '';
  return connection === '' || CONNECTION.test(connection) ? connection : null;
}

function roles(connection) {
  const scope = SCOPES[connection] ?? {};
  return [200, {
    connection,
    roles: ROLES.filter((role) => scope[role]).map((role) => {
      const versions = scope[role];
      const latest = versions.at(-1);
      const current = versions.filter((v) => v.status === 'accepted').at(-1)?.version ?? 0;
      return { role, current_version: current, versions: versions.length,
        latest: { version: latest.version, status: latest.status, summary: latest.summary, proposed_at: latest.proposed_at } };
    }),
  }];
}

function history(connection, role, page) {
  const versions = [...(SCOPES[connection]?.[role] ?? [])].reverse();
  let before = Number.POSITIVE_INFINITY;
  if (page !== '') {
    const parts = Buffer.from(page, 'base64url').toString().split('#');
    if (parts.length !== 3 || parts[0] !== connection || parts[1] !== role || !VERSION.test(parts[2])) {
      return [400, { error: 'page is not a page of this history: start again from its first page' }];
    }
    before = Number(parts[2]);
  }
  const below = versions.filter((v) => v.version < before);
  const shown = below.slice(0, PAGE);
  const current = versions.find((v) => v.status === 'accepted')?.version ?? 0;
  const more = below.length > PAGE ? encode(`${connection}#${role}#${shown.at(-1).version}`) : null;
  return [200, { connection, role, current_version: current, versions: shown.map(line), next_page: more }];
}

function detail(connection, role, raw) {
  if (!VERSION.test(raw)) return [400, { error: 'a version is a whole number from 1 to 999999' }];
  const found = SCOPES[connection]?.[role]?.find((v) => v.version === Number(raw));
  return found ? [200, { connection, role, version: found }] : [404, { error: 'no such skill version' }];
}

function scorecards(connection, role, raw) {
  if (connection === '') return [400, { error: "scorecards are a connection's: name the connection whose runs to compare" }];
  const parts = raw === null || raw === '' ? null : raw.split(',');
  if (parts && (parts.length > MAX_COMPARED || new Set(parts).size !== parts.length || !parts.every((p) => VERSION.test(p)))) {
    return [400, { error: `versions names 1 to ${MAX_COMPARED} versions, each once, separated by commas` }];
  }
  // (the default: the shipped version and the shipped ones before it, one source only, as views.py shipped_versions)
  const shipped = SHIPPED[role] ?? 0;
  const numbers = parts ? parts.map(Number) : Array.from({ length: Math.min(shipped, 5) }, (_, i) => shipped - i);
  const cards = numbers.map((n) => {
    const label = `${role}@${n}`;
    const card = connection === 'storefront' ? (CARDS[label] ?? EMPTY_CARD) : EMPTY_CARD;
    const ended = card.tasks_done + card.tasks_failed + card.needs_human;
    return { version: n, source: 'shipped', label, ...card, pass_rate: ended === 0 ? null : card.tasks_done / ended,
      more: false, since: card.runs ? daysAgo(14) : '', until: card.runs ? daysAgo(1) : '' };
  });
  return [200, { connection, role, source: 'shipped', scope_known: false, versions: numbers, cards }];
}

const SKILLS_PATH = /^\/agents\/engineering\/skills$/;
const HISTORY_PATH = /^\/agents\/engineering\/skills\/([^/]+)\/versions(?:\/([^/]+))?$/;
const SCORES_PATH = /^\/agents\/engineering\/scorecards\/([^/]+)$/;

function answer(url) {
  const connection = scopeOf(url);
  const badConnection = [400, { error: 'connection is a connection id (1 to 63 lower-case letters, digits or "-"), or empty for the shared skills' }];
  const badRole = [400, { error: `role is one of the agent roles: ${ROLES.join(', ')}` }];
  if (SKILLS_PATH.test(url.pathname)) return connection === null ? badConnection : roles(connection);
  const versions = HISTORY_PATH.exec(url.pathname);
  const scores = SCORES_PATH.exec(url.pathname);
  const role = decodeURIComponent((versions ?? scores)[1]);
  if (!ROLES.includes(role)) return badRole;
  if (connection === null) return badConnection;
  if (scores) return scorecards(connection, role, url.searchParams.get('versions'));
  return versions[2] === undefined ? history(connection, role, url.searchParams.get('page') ?? '')
    : detail(connection, role, decodeURIComponent(versions[2]));
}

export function handleEngineeringSkillRoutes(req, res, url, send) {
  const path = url.pathname;
  if (!SKILLS_PATH.test(path) && !HISTORY_PATH.test(path) && !SCORES_PATH.test(path)) return false;
  if (req.method !== 'GET') send(405, { message: 'Method not allowed' });
  else if (!isAdmin()) send(403, { message: 'Admin access required' });
  else send(...answer(url));
  return true;
}
