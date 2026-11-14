// An engineering run's monitor (docs/autonomous-agents.md "An engineering run"): the `/agents/engineering/<run_id>…`
// routes of agents_handler.py (lambda/engineering/monitor.py, views.py) in their wire shape, for one sample run
// (`/agents/engineering/01JDA7K3M9Q2R5T8V0W4X6Y1Z3`), its flow seeded in the workflow library by mock-server.js:
//   GET  …            the overview (run, each agent's session, totals per model; no cost yet)
//   GET  …/board      the tasks with their history
//   GET  …/conversation?after=   the 20 below `after` again, a page above it; `next_after` its last seq (the server's)
//   POST …/signals    {signal, task_id?, attempt?, note?, confirm?}: admin; 409 when the attempt moved on or the
//                     task is over, and the supervisor's reason for resuming a run out of budget; stop_now needs
//                     confirm: true; the request is recorded first as a signal.* message to the run, then its
//                     outcome (each agent's status, or why not); 503 when the agent is busy
//                     (MOCK_ENGINEERING_AGENT_BUSY=1), the request recorded
//   POST …/messages   {to: 'conductor' | 'agent', agent?, text, thread_id?}: admin; 404 for an agent not in the run
//   POST …/board/tasks {role, title, spec, priority?}: admin; a person posts a task (403 for the coordinator's role)
//   POST …/board/tasks/<task_id>/<action>: take {over?} | block {reason} | priority {priority} | move {to} | release (the
//                     last two only on a task the mock's admin took); 409 for an ended task or another person's hold without over
//   GET  …/reports    the run's reports, each with its latest version
//   GET  …/reports/<level>/<subject>?version=   one version: {report, markdown}; 404 for no such report or version
//   POST /agents/engineering/runs   {workflow_id, connection, commit, language, goal}: admin; a run's start, answered
//                     202 with the sample run (written, its coordinator's launch under way) (400 for a field off the server's rules)
//   GET|PUT /agents/engineering/settings   the administrators' hard cap {hard_cap, updated_at, updated_by}
//   GET  /agents/engineering/connections   the repository connections {connections, limit} (admin; never a secret)
//   PUT|DELETE /agents/engineering/connections/<id>   store one with its GitHub App credential, or keep the stored one
//                     (the server's field checks; 409 past the limit or for a repository change with live runs) | remove
//                     one (404 for an unknown id)
//   GET  /agents/engineering/spend?month=&by=&workflow=   the spend ledger's month, grouped (admin; 400 for a bad
//                     month, grouping or workflow id), from a few sample rows over this month and last
// Every GET of the overview moves the run a little (the agents' ages), so polling shows it live.
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403 on every route, as the server answers (admins only).
// Wired into mock-server.js by handleDomainModules (before the agents routes, which would read `engineering` as an
// agent id).

const SAMPLE_RUN_ID = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3';
export const SAMPLE_FLOW_ID = 'wf_7c2d9e41a0b3';
const PREFIX = '/agents/engineering/';
const SIGNALS = ['save', 'pause', 'resume', 'shutdown', 'stop_now'];
const TAIL_WINDOW = 20;
const MAX_ANSWER_BYTES = 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const isAdmin = () => process.env.MOCK_AGENTS_NON_ADMIN !== '1';

/** The sample run's flow (voc-workflow/2): a board of fixes, a quality gate, a stop at PR. */
export function sampleEngineeringFlow() {
  const node = (id, type, title, y, params = {}) => ({ id, type, position: { x: 240, y }, data: { title, params } });
  return {
    schema: 'voc-workflow/2',
    name: 'Fix the reported bugs',
    description: 'The coordinator posts a fix per confirmed bug; fixers take them; the gate reviews each change.',
    budget: { monthly_usd: 50 },
    nodes: [
      node('start', 'start', 'Start', 0),
      node('board', 'board', 'Fix board', 120, { posters: ['coordinator'], claimers: ['fixer'], until: 'drained' }),
      node('gate', 'quality_gate', 'Quality gate', 240, { max_rounds: 3, packs: 'auto' }),
      node('pr', 'stop_at_pr', 'Open the PR', 360),
      node('human', 'end', 'A person decides', 360, { status: 'needs_human' }),
    ],
    edges: [
      { id: 'e1', source: 'start', target: 'board' },
      { id: 'e2', source: 'board', target: 'gate' },
      { id: 'e3', source: 'gate', target: 'pr', label: 'pass' },
      { id: 'e4', source: 'gate', target: 'human', label: 'fail' },
    ],
    loops: [],
  };
}

const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();
const epochMinutesAgo = (n) => Math.floor(Date.now() / 1000) - n * 60;
const FINAL = new Set(['done', 'failed', 'needs_human']);

function agent(id, role, fields) {
  return {
    agent: id, role, task_id: null, status: 'working', continuation: 0, started_at: epochMinutesAgo(40), step: null,
    microvm_state: null, microvm_age: null, heartbeat_age: null, last_progress_at: null, stuck_why: null,
    recent_tools: [], microvm_seconds: 0, tokens: [], ...fields,
  };
}

const run = {
  meta: {
    run_id: SAMPLE_RUN_ID, goal: 'Fix the paging bugs reported this week', repo: 'example-org/storefront',
    flow: SAMPLE_FLOW_ID, status: 'running', started_at: minutesAgo(42), ended_at: null,
    // Its flow's $50 budget, copied at the start; the flow's month passed 80% of it (the supervisor's flag).
    budget: { monthly_usd: 50, alert_percent: 80, alert_month: new Date().toISOString().slice(0, 7) },
  },
  agents: [
    agent('coordinator-1', 'coordinator', {
      status: 'waiting', step: 'board', microvm_state: 'suspended', microvm_age: 2520, heartbeat_age: 360,
      last_progress_at: epochMinutesAgo(30), recent_tools: ['read_issue', 'post_task', 'post_task', 'post_task'],
      microvm_seconds: 310, tokens: [{ model: 'model-large', input_tokens: 42_000, output_tokens: 6_100 }],
    }),
    agent('fixer-3', 'fixer', {
      task_id: 'task-fix-page-size', continuation: 1, step: 'board', microvm_state: 'running', microvm_age: 1500,
      heartbeat_age: 5, last_progress_at: epochMinutesAgo(1), recent_tools: ['read_file', 'run_tests', 'edit_file'],
      microvm_seconds: 1_420, tokens: [{ model: 'model-medium', input_tokens: 61_500, output_tokens: 9_800 }],
    }),
    agent('final-go-5', 'final-go', {
      task_id: 'task-gate-empty', step: 'Reading the review rounds', microvm_state: 'running', microvm_age: 720,
      heartbeat_age: 540, last_progress_at: epochMinutesAgo(11), recent_tools: ['read_record'],
      stuck_why: 'No progress for 10 minutes: the supervisor asked for its state', microvm_seconds: 640,
      tokens: [{ model: 'model-large', input_tokens: 12_000, output_tokens: 900 }],
    }),
  ],
  tasks: [
    {
      task_id: 'task-fix-page-size', role: 'fixer', state: 'in_progress', title: 'The last page shows one item too many',
      spec: { issue: 7 }, depth: 1, priority: 1, attempt: 2, parent_task: null,
      lease: { agent: 'fixer-3', epoch: 2, expires: 0 }, result_keys: [], posted_by: 'coordinator-1',
      updated_by: 'fixer-3', updated_at: minutesAgo(1), spec_hash: 'a1',
      history: [
        { state: 'open', at: minutesAgo(30), by: 'coordinator-1', op: 'post', attempt: 1, result_keys: 0 },
        { state: 'claimed', at: minutesAgo(28), by: 'fixer-2', op: 'claim', attempt: 1, result_keys: 0 },
        // (fixer-2 stalled: the supervisor re-posted the task at its next attempt; an ended task is never re-posted)
        { state: 'open', at: minutesAgo(26), by: 'supervisor', op: 'repost', attempt: 2, result_keys: 0 },
        { state: 'claimed', at: minutesAgo(25), by: 'fixer-3', op: 'claim', attempt: 2, result_keys: 0 },
        { state: 'in_progress', at: minutesAgo(24), by: 'fixer-3', op: 'move', attempt: 2, result_keys: 0 },
      ],
    },
    {
      task_id: 'task-fix-sort', role: 'fixer', state: 'open', title: 'Sorting by date ignores the time zone',
      spec: { issue: 9 }, depth: 1, priority: 2, attempt: 1, parent_task: null, lease: null, result_keys: [],
      posted_by: 'coordinator-1', updated_by: 'coordinator-1', updated_at: minutesAgo(30), spec_hash: 'b2',
      history: [{ state: 'open', at: minutesAgo(30), by: 'coordinator-1', op: 'post', attempt: 1, result_keys: 0 }],
    },
    {
      task_id: 'task-fix-empty', role: 'fixer', state: 'done', title: 'An empty search shows an error',
      spec: { issue: 4 }, depth: 1, priority: 1, attempt: 1, parent_task: null, lease: null, result_keys: ['k1'],
      posted_by: 'coordinator-1', updated_by: 'fixer-4', updated_at: minutesAgo(14), spec_hash: 'c3',
      history: [
        { state: 'open', at: minutesAgo(30), by: 'coordinator-1', op: 'post', attempt: 1, result_keys: 0 },
        { state: 'done', at: minutesAgo(14), by: 'fixer-4', op: 'move', attempt: 1, result_keys: 1 },
      ],
    },
    {
      task_id: 'task-gate-empty', role: 'final-go', state: 'done', title: 'The gate record for the empty search fix',
      spec: { commit: 'abc1234' }, depth: 2, priority: 1, attempt: 1, parent_task: 'task-fix-empty',
      lease: { agent: 'final-go-5', epoch: 1, expires: 0 }, result_keys: ['k2'], posted_by: 'coordinator-1',
      updated_by: 'final-go-5', updated_at: minutesAgo(12), spec_hash: 'd4',
      history: [
        { state: 'claimed', at: minutesAgo(13), by: 'final-go-5', op: 'claim', attempt: 1, result_keys: 0 },
        { state: 'done', at: minutesAgo(12), by: 'final-go-5', op: 'move', attempt: 1, result_keys: 1 },
      ],
    },
  ],
  /** MOCK_ENGINEERING_OUT_OF_BUDGET=1: the run has spent its budget, so a resume is refused with the supervisor's reason. */
  outOfBudget: process.env.MOCK_ENGINEERING_OUT_OF_BUDGET === '1',
  /** MOCK_ENGINEERING_AGENT_BUSY=1: the supervisor answers busy for an agent signalled (503; the request and its
   *  "not applied" outcome are recorded). */
  agentBusy: process.env.MOCK_ENGINEERING_AGENT_BUSY === '1',
  messages: [],
};

function say(from, to, type, summary, { threadId = 't-run', taskId, at = new Date().toISOString() } = {}) {
  const seq = run.messages.length + 1;
  run.messages.push({
    seq, event_id: `evt-${seq}`, type, at,
    message: { schema: 'voc-msg/1', from, to, type, summary, thread_id: threadId, at, ...(taskId ? { task_id: taskId } : {}) },
  });
  return `evt-${seq}`;
}

say({ kind: 'conductor', id: SAMPLE_RUN_ID }, { kind: 'run', id: SAMPLE_RUN_ID }, 'run.started', 'Started: three bugs to fix', { at: minutesAgo(42) });
say({ kind: 'system', id: 'board' }, { kind: 'role', id: 'fixer' }, 'task.posted', 'The last page shows one item too many', { taskId: 'task-fix-page-size', at: minutesAgo(30) });
say({ kind: 'agent', id: 'fixer-3' }, { kind: 'conductor', id: SAMPLE_RUN_ID }, 'msg.question', 'Is the page size inclusive of the last item?', { threadId: 't-page-size', at: minutesAgo(20) });
say({ kind: 'system', id: 'board' }, { kind: 'run', id: SAMPLE_RUN_ID }, 'task.done', 'An empty search shows an error: done', { taskId: 'task-fix-empty', at: minutesAgo(14) });

function overview() {
  for (const a of run.agents) {
    if (a.microvm_age !== null) a.microvm_age += 5;
    if (a.heartbeat_age !== null) a.heartbeat_age = a.agent === 'fixer-3' ? 5 : a.heartbeat_age + 5;
  }
  const byModel = new Map();
  for (const a of run.agents) {
    for (const row of a.tokens) {
      const sum = byModel.get(row.model) ?? { model: row.model, input_tokens: 0, output_tokens: 0 };
      sum.input_tokens += row.input_tokens;
      sum.output_tokens += row.output_tokens;
      byModel.set(row.model, sum);
    }
  }
  return {
    run: run.meta,
    agents: run.agents,
    // The dev mock plays a stack that names the runtime and the bus, so its actions answer.
    actions_available: true,
    totals: {
      messages: run.messages.length, microvm_seconds: run.agents.reduce((sum, a) => sum + a.microvm_seconds, 0),
      by_model: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)),
    },
  };
}

function conversation(url) {
  const after = Math.max(Number(url.searchParams.get('after')) || 0, 0);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  // Every page reads the window below `after` again, then at most `limit` above it, and moves on to its last seq.
  const window = run.messages.filter((m) => m.seq > after - TAIL_WINDOW && m.seq <= after);
  const above = run.messages.filter((m) => m.seq > after).slice(0, limit);
  const items = [...window, ...above];
  return { items, next_after: Math.max(after, ...items.map((m) => m.seq)) };
}

/** The agent a signal reaches, or the refusal: the task's holder at the attempt the person saw. */
function signalTarget(body) {
  if (body.task_id === undefined) {
    return body.attempt === undefined ? { kind: 'run', id: SAMPLE_RUN_ID } : [400, 'attempt goes with a task_id (a signal to the whole run has none)'];
  }
  const task = run.tasks.find((t) => t.task_id === body.task_id);
  if (!task) return [404, 'no such task in this run'];
  if (!task.lease || task.lease.epoch !== body.attempt || task.state === 'open' || FINAL.has(task.state)) {
    return [409, 'This task has moved on since you looked: reload the run'];
  }
  if (task.lease.agent.startsWith('human:')) return [409, 'A person holds this task: no agent works on it to signal'];
  return { kind: 'agent', id: task.lease.agent };
}

function signal(body) {
  if (!SIGNALS.includes(body?.signal)) return [400, { message: `signal is one of ${SIGNALS.join(', ')}` }];
  if (body.signal === 'stop_now' && body.confirm !== true) return [400, { message: 'stop_now stops without a checkpoint: send confirm: true' }];
  const target = signalTarget(body);
  if (Array.isArray(target)) return [target[0], { message: target[1] }];
  // The request is recorded first (as the server does), then the supervisor applies it or refuses.
  const at = new Date().toISOString();
  const whom = target.kind === 'agent' ? `agent ${target.id}` : 'the whole run';
  const request = say({ kind: 'human', id: 'mock-admin' }, { kind: 'run', id: SAMPLE_RUN_ID }, `signal.${body.signal}`,
    `${body.signal.replace('_', ' ')} requested from the run monitor by alex for ${whom}.`, { threadId: 'signals', taskId: body.task_id, at });
  const notApplied = (why) => say({ kind: 'human', id: 'mock-admin' }, { kind: 'run', id: SAMPLE_RUN_ID }, `signal.${body.signal}`,
    `signal.${body.signal} request ${request}: not applied: ${why}`, { threadId: 'signals', taskId: body.task_id });
  if (body.signal === 'resume' && run.outOfBudget) {
    const reason = `run ${SAMPLE_RUN_ID} has spent its budget: raise it before resuming`;
    notApplied(reason);
    return [409, { message: reason }];
  }
  if (target.kind === 'agent' && run.agentBusy) {
    notApplied('the agent was busy with another move');
    return [503, { message: 'The agent is busy with another move: send the signal again' }];
  }
  const reached = run.agents.filter((a) => target.kind === 'run' || a.agent === target.id);
  const next = { save: null, pause: 'pause_requested', resume: 'working', shutdown: 'pause_requested', stop_now: 'stopped' }[body.signal];
  // As the supervisor answers: a Save checkpoints (applied); any other signal is applied when it changes the status
  // (a Resume of an agent already working is nothing to do).
  const applied = Object.fromEntries(reached.map((a) => [a.agent, next === null || a.status !== next]));
  for (const a of reached) if (next) a.status = next;
  const agents = Object.fromEntries(reached.map((a) => [a.agent, a.status]));
  const listed = (done) => Object.entries(agents).filter(([id]) => applied[id] === done).map(([id, status]) => `${id} ${status}`).join(', ');
  const outcome = [listed(true) && `applied: ${listed(true)}`, listed(false) && `not applied: ${listed(false)}`].filter(Boolean).join('; ') || 'no agent yet';
  say({ kind: 'human', id: 'mock-admin' }, { kind: 'run', id: SAMPLE_RUN_ID }, `signal.${body.signal}`,
    `signal.${body.signal} request ${request}: ${outcome}`, { threadId: 'signals', taskId: body.task_id });
  return [200, { signal: { event_id: request, signal: body.signal, target, attempt: body.attempt ?? 0, agents, applied, at } }];
}

function answer(body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (text === '' || Buffer.byteLength(text) > MAX_ANSWER_BYTES) return [400, { message: `text is what you say, at most ${MAX_ANSWER_BYTES} bytes` }];
  const to = body.to === 'conductor' ? { kind: 'conductor', id: SAMPLE_RUN_ID } : { kind: 'agent', id: body.agent };
  if (body.to !== 'conductor' && !(body.to === 'agent' && typeof body.agent === 'string')) {
    return [400, { message: "to is 'conductor', or 'agent' with the agent's id in agent" }];
  }
  if (to.kind === 'agent' && !run.agents.some((a) => a.agent === to.id)) return [404, { message: 'no such agent in this run' }];
  if (body.thread_id !== undefined && !ID.test(String(body.thread_id))) return [400, { message: 'thread_id is the id of the thread you answer' }];
  const threadId = body.thread_id ?? `human-${run.messages.length + 1}`;
  const at = new Date().toISOString();
  say({ kind: 'human', id: 'mock-admin' }, to, 'msg.answer', text, { threadId, at });
  return [200, { message: { event_id: `evt-${run.messages.length}`, thread_id: threadId, at } }];
}

/** The sample run's reports: a goal report written twice, one commit's report (the builder's Markdown, abridged). */
const REPORTS = [
  { level: 'goal', subject: SAMPLE_RUN_ID, versions: [minutesAgo(25), minutesAgo(10)] },
  { level: 'commit', subject: '3f9c2a7e5b1d4c6f8a0e2b4d6f8a1c3e5b7d9f0a', versions: [minutesAgo(12)] },
];

function reportMarkdown(entry, version) {
  return [
    `# ${entry.level === 'goal' ? 'Goal' : 'Commit'} report: ${run.meta.goal}`, '',
    `Version ${version} · ${entry.subject}`, '',
    '## Cost', '', '| Events | MicroVM time | Tokens in | Tokens out |', '| --- | --- | --- | --- |',
    `| ${run.messages.length} | ${version * 420} s | ${version * 2000} | ${version * 400} |`, '',
    '## Findings', '', version === 1 ? 'None yet.' : '- `src/search/paging.ts:41` (high): the last page shows one item too many',
  ].join('\n');
}

function reports(rest, url) {
  if (rest.length === 0) {
    return [200, { items: REPORTS.map((r) => ({ level: r.level, subject: r.subject, latest_version: r.versions.length })) }];
  }
  const [level, subject] = rest;
  const entry = REPORTS.find((r) => r.level === level && r.subject === subject);
  const asked = url.searchParams.get('version');
  const version = asked === null ? entry?.versions.length : Number(asked);
  if (rest.length !== 2 || !entry || !Number.isInteger(version) || version < 1 || version > entry.versions.length) {
    return [404, { message: 'Report not found' }];
  }
  const builtAt = entry.versions[version - 1];
  return [200, { report: { schema: 'voc-report/1', level, subject, version, built_at: builtAt }, markdown: reportMarkdown(entry, version) }];
}

function routeGet(sub, rest, url) {
  if (sub === 'reports') return reports(rest, url);
  if (rest.length > 0) return [404, { message: 'Engineering run not found' }];
  if (sub === undefined) return [200, overview()];
  if (sub === 'board') return [200, { tasks: run.tasks }];
  if (sub === 'conversation') return [200, conversation(url)];
  return [404, { message: 'Engineering run not found' }];
}

/** The dev mock's signed-in admin, as a person on the board (the mock's admin user's sub). */
const PERSON = 'human:sub-admin-demo';
const CLAIMERS = ['builder', 'commit-reviewer', 'committer', 'final-go', 'fixer', 'hunter', 'mapper', 'pr-author',
  'pr-reviewer', 'understander'];
const MOVES = {
  claimed: ['in_progress', 'failed', 'needs_human'],
  in_progress: ['in_review', 'done', 'failed', 'needs_human'],
  in_review: ['in_progress', 'done', 'failed', 'needs_human'],
};

function changed(task, state, op, reason) {
  const at = new Date().toISOString();
  Object.assign(task, { state, updated_by: PERSON, updated_at: at });
  task.history.push({ state, at, by: PERSON, op, attempt: task.attempt, result_keys: 0, ...(reason ? { reason } : {}) });
  say({ kind: 'human', id: 'sub-admin-demo' }, { kind: 'run', id: SAMPLE_RUN_ID }, `task.${state === 'open' ? 'progress' : state}`,
    `${task.title} (${state}): ${op} by a person`, { threadId: task.task_id, taskId: task.task_id, at });
  return [200, { task }];
}

/** A person posts a task (`POST …/board/tasks`), as the board does. */
function postTask(body) {
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!CLAIMERS.includes(body.role)) return [body.role === 'coordinator' ? 403 : 400, { message: 'unknown role' }];
  if (!title || typeof body.spec !== 'object' || body.spec === null) return [400, { message: '"title" and "spec" are required' }];
  // As the board (spec_hash: role, parent task, spec): an equal task still under way is answered, nothing posted.
  const equal = run.tasks.find((t) => t.role === body.role && !FINAL.has(t.state)
    && (t.parent_task || '') === (body.parent_task || '')
    && JSON.stringify(t.spec) === JSON.stringify(body.spec));
  if (equal) return [200, { task: equal, duplicate: true }];
  const at = new Date().toISOString();
  const task = {
    task_id: `task-person-${run.tasks.length + 1}`, role: body.role, state: 'open', title, spec: body.spec, depth: 0,
    priority: Number.isInteger(body.priority) ? body.priority : 0, attempt: 1, parent_task: null, lease: null,
    result_keys: [], posted_by: PERSON, updated_by: PERSON, updated_at: at, spec_hash: `p${run.tasks.length + 1}`,
    history: [{ state: 'open', at, by: PERSON, op: 'post', attempt: 1, result_keys: 0 }],
  };
  run.tasks.push(task);
  say({ kind: 'human', id: 'sub-admin-demo' }, { kind: 'role', id: task.role }, 'task.posted', title, { threadId: task.task_id, taskId: task.task_id, at });
  return [200, { task, duplicate: false }];
}

/** Another person's hold is ended (taken or blocked) only when `over` asks for it. */
function heldByAnother(task, body) {
  if (body.over !== undefined && typeof body.over !== 'boolean') return [400, { message: '"over" is true or false' }];
  if (task.lease?.agent?.startsWith('human:') && task.lease.agent !== PERSON && body.over !== true) {
    return [409, { message: 'another person holds the task: take it over only if you mean to' }];
  }
  return null;
}

const ACTIONS = {
  take(task, body) {
    const refused = heldByAnother(task, body);
    if (refused) return refused;
    task.lease = { agent: PERSON, epoch: task.attempt, expires: 253402300799 };
    return changed(task, task.state === 'open' ? 'claimed' : task.state, 'take');
  },
  block(task, body) {
    if (typeof body.reason !== 'string' || !body.reason.trim()) return [400, { message: 'a block says why (a line)' }];
    const refused = heldByAnother(task, body);
    if (refused) return refused;
    task.lease = null;
    return changed(task, 'needs_human', 'block', body.reason.trim());
  },
  priority(task, body) {
    if (!Number.isInteger(body.priority)) return [400, { message: '"priority" is a whole number' }];
    task.priority = body.priority;
    return changed(task, task.state, 'priority', `priority ${body.priority}`);
  },
  release(task) {
    // As the store: their own release again is answered as it is; only the holder gives a task back.
    const last = task.history.at(-1);
    if (task.state === 'open' && last?.op === 'release' && last.by === PERSON) return [200, { task }];
    if (task.lease?.agent !== PERSON) return [403, { message: 'only a task you hold is given back by you: read the board again' }];
    const at = new Date().toISOString();
    Object.assign(task, { state: 'open', attempt: task.attempt + 1, lease: null, updated_by: PERSON, updated_at: at });
    task.history.push({ state: 'open', at, by: PERSON, op: 'release', attempt: task.attempt, result_keys: 0, reason: 'released by a person' });
    // Open for its role again, as a re-post: the role is told (task.posted), as the person.
    say({ kind: 'human', id: 'sub-admin-demo' }, { kind: 'role', id: task.role }, 'task.posted',
      `${task.title} (open, by ${PERSON})`, { threadId: task.task_id, taskId: task.task_id, at });
    return [200, { task }];
  },
  move(task, body) {
    if (body.to === 'needs_human') return [400, { message: 'a task needs a person by block, with a reason: not by a move' }];
    if (task.lease?.agent !== PERSON) return [403, { message: 'only a task you took is moved by you: take it first' }];
    // As the store: a state no move reaches is a bad request; one that is not a move from this state, a conflict.
    if (!Object.values(MOVES).some((targets) => targets.includes(body.to))) {
      return [400, { message: `a task cannot be moved to ${String(body.to)}` }];
    }
    if (!(MOVES[task.state] ?? []).includes(body.to)) return [409, { message: 'the task cannot move from its state' }];
    return changed(task, body.to, 'move');
  },
};

/** A person's action on one task (`POST …/board/tasks/<task_id>/<action>`), as the board does. */
function actOnTask(taskId, action, body) {
  const task = run.tasks.find((t) => t.task_id === taskId);
  if (!task) return [404, { message: 'no such task' }];
  if (taskId === 'coordinate') return [403, { message: "the coordinate task is the run coordinator's" }];
  if (FINAL.has(task.state)) return [409, { message: 'the task has ended' }];
  if (!Object.hasOwn(ACTIONS, action)) return [400, { message: 'the action is one of block, move, priority, release, take' }];
  return ACTIONS[action](task, body);
}

function routePost(sub, rest, body) {
  if (!isAdmin()) return [403, { message: 'Admin access required' }];
  if (run.meta.ended_at !== null && sub === 'board') return [409, { message: 'This run has ended' }];
  if (sub === 'board' && rest[0] === 'tasks' && rest.length === 1) return postTask(body ?? {});
  if (sub === 'board' && rest[0] === 'tasks' && rest.length === 3) return actOnTask(rest[1], rest[2], body ?? {});
  if (rest.length > 0) return [404, { message: 'Engineering run not found' }];
  if (sub === 'signals') return signal(body ?? {});
  if (sub === 'messages') return answer(body ?? {});
  return [404, { message: 'Engineering run not found' }];
}

// ── The spend ledger (GET /agents/engineering/spend?month=&by=&workflow=; lambda/engineering/spend.py) ──
// Rows for this month (the sample run, and an earlier run of the same flow) and last month (one run of another
// flow), in the ledger's shape: one per day, run, agent and model; `microvm` carries MicroVM time, the only priced
// one (model tokens are counted, not yet priced: their rows have no dollars, as the server's).
const SPEND_BY = { workflow: 'flow', repo: 'repo', run: 'run_id', agent: 'agent_id', model: 'model', day: 'day' };
const OTHER_FLOW_ID = 'wf_3f8a1b62c9d0';
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;   // (spend.py's ledger_pk)

function spendRows(now = new Date()) {
  const monthOf = (back) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1)).toISOString().slice(0, 7);
  const today = String(now.getUTCDate()).padStart(2, '0');
  const row = (month, day, flow, run_id, agent_id, model, usd, tokens_in, tokens_out, microvm_seconds = 0) => ({
    month, day, flow, repo: 'example-org/storefront', run_id, agent_id, model, usd, tokens_in, tokens_out, microvm_seconds,
  });
  const earlier = '01JD9Q4W2E7R1T6Y3U8I0O5P2A';
  return [
    row(monthOf(0), today, SAMPLE_FLOW_ID, SAMPLE_RUN_ID, 'coordinator-1', 'model-large', 0, 42_000, 6_100),
    row(monthOf(0), today, SAMPLE_FLOW_ID, SAMPLE_RUN_ID, 'coordinator-1', 'microvm', 0.0031, 0, 0, 310),
    row(monthOf(0), today, SAMPLE_FLOW_ID, SAMPLE_RUN_ID, 'fixer-3', 'model-medium', 0, 61_500, 9_800),
    row(monthOf(0), today, SAMPLE_FLOW_ID, SAMPLE_RUN_ID, 'fixer-3', 'microvm', 0.0142, 0, 0, 1_420),
    row(monthOf(0), today, SAMPLE_FLOW_ID, SAMPLE_RUN_ID, 'final-go-5', 'model-large', 0, 12_000, 900),
    row(monthOf(0), '01', SAMPLE_FLOW_ID, earlier, 'fixer-1', 'model-medium', 0, 240_000, 31_000),
    // (a long run early in the month: with the rest, the flow's month is past 80% of its $50 budget, as the run's flag)
    row(monthOf(0), '01', SAMPLE_FLOW_ID, earlier, 'fixer-1', 'microvm', 40.5, 0, 0, 7_200),
    row(monthOf(1), '17', OTHER_FLOW_ID, '01JC2M8N4B6V0C3X5Z7L9K1J4H', 'hunter-1', 'model-small', 0, 30_000, 2_000),
    row(monthOf(1), '17', OTHER_FLOW_ID, '01JC2M8N4B6V0C3X5Z7L9K1J4H', 'hunter-1', 'microvm', 0.009, 0, 0, 900),
  ];
}

/** The month's spend grouped `by` (biggest first), as spend.py's MonthSpend.view() answers it. */
function monthSpend(url) {
  const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
  const by = url.searchParams.get('by') ?? 'workflow';
  const flow = url.searchParams.get('workflow') ?? '';
  if (!MONTH.test(month)) return [400, { message: 'month is YYYY-MM' }];
  if (!(by in SPEND_BY)) return [400, { message: `by is one of ${Object.keys(SPEND_BY).join(', ')}` }];
  if (flow.length > 500 || flow.includes('#')) return [400, { message: 'workflow is a workflow id' }];
  const zero = () => ({ usd: 0, tokens_in: 0, tokens_out: 0, microvm_seconds: 0 });
  const add = (sum, row) => {
    for (const field of ['usd', 'tokens_in', 'tokens_out', 'microvm_seconds']) sum[field] += row[field];
  };
  const total = zero();
  const groups = new Map();
  for (const row of spendRows().filter((r) => r.month === month && (flow === '' || r.flow === flow))) {
    const value = row[SPEND_BY[by]];
    const key = by === 'agent' ? `${row.run_id}/${value}` : value;
    if (!groups.has(key)) groups.set(key, zero());
    add(groups.get(key), row);
    add(total, row);
  }
  const ordered = [...groups.entries()].sort(([ka, a], [kb, b]) =>
    b.usd - a.usd || (b.tokens_in + b.tokens_out) - (a.tokens_in + a.tokens_out) || b.microvm_seconds - a.microvm_seconds || ka.localeCompare(kb));
  return [200, { month, by, total, truncated: false, groups: ordered.map(([key, sum]) => ({ key, ...sum })) }];
}

// ── The administrators' hard cap (GET/PUT /agents/engineering/settings; engineering/settings.py) ──
const settings = { hard_cap: false, updated_at: null, updated_by: null };
const settingsView = () => ({ ...settings });

function settingsRoute(req, res, send, shared) {
  if (!isAdmin()) return send(403, { message: 'Admin access required' });
  if (req.method === 'GET') return send(200, settingsView());
  if (req.method !== 'PUT') return send(405, { message: 'Method not allowed' });
  return shared.collectJson(req, res, (body) => {
    if (!body || Object.keys(body).length !== 1 || typeof body.hard_cap !== 'boolean') {
      return send(400, { message: 'the body is {hard_cap: true | false}' });
    }
    Object.assign(settings, { hard_cap: body.hard_cap, updated_at: new Date().toISOString(), updated_by: 'admin-demo' });
    return send(200, settingsView());
  });
}

// ── The repository connections (GET /agents/engineering/connections, PUT|DELETE …/connections/<id>) ──
// The engineering connectors' `connections` module's rules. The GitHub App's private key is taken and never answered: a connection says only
// whether its credential is set, and the App's ids. A save without a credential keeps the stored one (a new connection,
// or a new repository, needs it); a live run on 'storefront' refuses its repository change (409).
const CONNECTION_PATH = /^\/agents\/engineering\/connections(?:\/([^/]*))?$/;
const CONNECTION_LIMIT = 20;
const CONNECTION_FIELDS = ['host', 'repository', 'default_branch', 'credential'];
const CREDENTIAL_FIELDS = ['app_id', 'installation_id', 'private_key'];
const LIVE_RUN_CONNECTIONS = new Set(['storefront']);
const connections = new Map([['storefront', {
  connection_id: 'storefront', host: 'github', repository: 'example-org/storefront', default_branch: 'main',
  credential: { kind: 'app', set: true, app_id: '104729', installation_id: '7919001' },
  created_at: minutesAgo(60 * 24 * 9), created_by: 'admin-demo', updated_at: minutesAgo(60 * 24 * 2), updated_by: 'admin-demo',
}]]);
const DIGITS = /^[1-9]\d{0,19}$/;
const PEM = /^-----BEGIN (RSA |)PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END \1PRIVATE KEY-----$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/** The stored credential's state for a save's credential (never the key), or the 400 message of a bad one. */
function credentialState(credential) {
  if (typeof credential !== 'object' || credential === null
    || Object.keys(credential).sort().join() !== CREDENTIAL_FIELDS.join()) {
    return 'credential is {app_id, installation_id, private_key}: the GitHub App\'s';
  }
  const { app_id: appId, installation_id: installationId, private_key: key } = credential;
  if (!DIGITS.test(String(appId))) return 'app_id is the GitHub App\'s number';
  if (!DIGITS.test(String(installationId))) return 'installation_id is the GitHub App\'s number';
  if (typeof key !== 'string' || !PEM.test(key.replaceAll('\r\n', '\n').trim())) {
    return 'private_key is an unencrypted RSA private key in PEM';
  }
  return { kind: 'app', set: true, app_id: String(appId), installation_id: String(installationId) };
}

function isBranch(branch) {
  return typeof branch === 'string' && BRANCH.test(branch) && !branch.includes('..') && !branch.includes('@{')
    && !/[/.]$/.test(branch) && !branch.startsWith('voc-agent/')
    && branch.split('/').every((part) => part !== '' && !part.startsWith('.') && !part.endsWith('.lock'));
}

/** The 400 message of a body off the rules, else null. */
function connectionBodyIssue(id, body) {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) return 'the connection id is 1 to 63 lower-case letters, digits or "-"';
  if (!body || Object.keys(body).some((key) => !CONNECTION_FIELDS.includes(key))) return 'the body is {host, repository, default_branch, credential?}';
  if (body.host !== 'github') return 'host is github (GitLab is planned)';
  const [owner = '', name = '', ...rest] = typeof body.repository === 'string' ? body.repository.split('/') : [];
  const repoOk = rest.length === 0 && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) && /^[A-Za-z0-9._-]{1,100}$/.test(name)
    && name !== '.' && name !== '..';
  if (!repoOk) return 'repository is the GitHub repository as owner/name';
  if (!isBranch(body.default_branch)) return 'default_branch is a branch name git accepts, not an agent\'s voc-agent/ branch';
  return null;
}

/** The credential a save leaves stored, or the 400 message: a save without one keeps the stored one. */
function savedCredential(before, body) {
  if (body.credential !== undefined && body.credential !== null) return credentialState(body.credential);
  if (before === undefined) return 'credential is needed to add a connection';
  if (before.repository !== body.repository || !before.credential.set) {
    return 'credential is needed again: the stored one holds the repository it was saved with';
  }
  return before.credential;
}

function saveConnection(id, body) {
  const issue = connectionBodyIssue(id, body);
  if (issue !== null) return [400, { message: issue }];
  const before = connections.get(id);
  const credential = savedCredential(before, body);
  if (typeof credential === 'string') return [400, { message: credential }];
  if (before === undefined && connections.size >= CONNECTION_LIMIT) {
    return [409, { message: `at most ${CONNECTION_LIMIT} connections: remove one to add another` }];
  }
  if (before !== undefined && before.repository !== body.repository && LIVE_RUN_CONNECTIONS.has(id)) {
    return [409, { message: '1 run(s) of this connection are live: the repository changes once they end (or stop them first)' }];
  }
  const now = new Date().toISOString();
  const connection = {
    connection_id: id, host: 'github', repository: body.repository, default_branch: body.default_branch, credential,
    created_at: before?.created_at ?? now, created_by: before?.created_by ?? 'admin-demo', updated_at: now, updated_by: 'admin-demo',
  };
  connections.set(id, connection);
  return [200, { connection, created: before === undefined }];
}

function connectionsRoute(req, res, send, shared, id) {
  if (!isAdmin()) return send(403, { message: 'Admin access required' });
  if (id === undefined) {
    if (req.method !== 'GET') return send(405, { message: 'Method not allowed' });
    return send(200, { connections: [...connections.values()], limit: CONNECTION_LIMIT });
  }
  if (req.method === 'DELETE') {
    if (!connections.delete(id)) return send(404, { message: 'Connection not found' });
    return send(200, { removed: true });
  }
  if (req.method !== 'PUT') return send(405, { message: 'Method not allowed' });
  return shared.collectJson(req, res, (body) => send(...saveConnection(id, body)));
}

// ── A run's start (POST /agents/engineering/runs; agents_handler.py start_engineering_run) ──
// The server's checks (a connection's short id, a 40-character commit, an image language, a goal of 1-500 characters
// on one line, nothing else in the body); a start answers the sample run, so the monitor it opens has something to show.
const START_FIELDS = ['workflow_id', 'connection', 'commit', 'language', 'goal'];
const RUN_LANGUAGES = ['java', 'node', 'python', 'rust'];

const oneLine = (text) => text.split(/\s+/).filter(Boolean).join(' ');
/** Each check of a well-formed body, with what its 400 says. */
const START_CHECKS = [
  [(f) => /^[A-Za-z0-9-]{1,63}$/.test(f.connection.trim()), 'connection must be 1-63 letters, digits or "-"'],
  [(f) => /^[0-9a-f]{40}$/.test(f.commit.trim().toLowerCase()), 'commit is a full commit id: 40 hexadecimal characters'],
  [(f) => RUN_LANGUAGES.includes(f.language), `language is one of ${RUN_LANGUAGES.join(', ')}`],
  [(f) => oneLine(f.goal) !== '' && Array.from(oneLine(f.goal)).length <= 500,
    'goal says what the run is for, in 1 to 500 characters'],
  [(f) => /^wf_[0-9a-f]{12}$/.test(f.workflow_id), 'workflow_id does not name a saved workflow'],
];

function startRun(body) {
  const fields = body && typeof body === 'object' ? body : {};
  const wellFormed = Object.keys(fields).every((key) => START_FIELDS.includes(key))
    && START_FIELDS.every((key) => typeof fields[key] === 'string');
  if (!wellFormed) return [400, { message: 'the body is {workflow_id, connection, commit, language, goal}, each a string' }];
  const failed = START_CHECKS.find(([passes]) => !passes(fields));
  if (failed) return [400, { message: failed[1] }];
  // 202, as the server: the run is written and its coordinator's launch is under way.
  return [202, { run: { run_id: SAMPLE_RUN_ID, status: 'active', workflow_id: fields.workflow_id, started_by: 'sub-admin-demo' } }];
}

function startRoute(req, res, send, shared) {
  if (req.method !== 'POST') send(405, { message: 'Method not allowed' });
  else if (!isAdmin()) send(403, { message: 'Admin access required' });
  else shared.collectJson(req, res, (body) => send(...startRun(body)));
}

function spendRoute(req, res, send, _shared, url) {
  if (req.method !== 'GET') send(405, { message: 'Method not allowed' });
  else if (isAdmin()) send(...monthSpend(url));
  else send(403, { message: 'Admin access required' });
}

/** The routes of one exact path under the prefix. */
const EXACT_ROUTES = { runs: startRoute, settings: settingsRoute, spend: spendRoute };

export function handleEngineeringRunRoutes(req, res, url, send, shared) {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const connection = CONNECTION_PATH.exec(url.pathname);
  if (connection) {
    connectionsRoute(req, res, send, shared, connection[1] === undefined ? undefined : decodeURIComponent(connection[1]));
    return true;
  }
  const exact = url.pathname.slice(PREFIX.length);
  if (Object.hasOwn(EXACT_ROUTES, exact)) {
    EXACT_ROUTES[exact](req, res, send, shared, url);
    return true;
  }
  const [runId, sub, ...rest] = url.pathname.slice(PREFIX.length).split('/').map(decodeURIComponent);
  const nested = (req.method === 'GET' && sub === 'reports') || (req.method === 'POST' && sub === 'board');
  if (runId !== SAMPLE_RUN_ID || (rest.length > 0 && !nested)) {
    send(404, { message: 'Engineering run not found' });
    return true;
  }
  if (!isAdmin()) {
    send(403, { message: 'Admin access required' });
    return true;
  }
  if (req.method === 'GET') {
    const [status, payload] = routeGet(sub, rest, url);
    send(status, payload);
    return true;
  }
  if (req.method !== 'POST') {
    send(405, { message: 'Method not allowed' });
    return true;
  }
  shared.collectJson(req, res, (body) => {
    const [status, payload] = routePost(sub, rest, body);
    send(status, payload);
  });
  return true;
}
