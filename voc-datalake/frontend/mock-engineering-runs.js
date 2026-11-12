// An engineering run's monitor (docs/autonomous-agents.md "An engineering run"): the `/agents/engineering/<run_id>…`
// routes of agents_handler.py (lambda/engineering/monitor.py, views.py) in their wire shape, for one sample run
// (`/agents/engineering/01JDA7K3M9Q2R5T8V0W4X6Y1Z3`), its flow seeded in the workflow library by mock-server.js:
//   GET  …            the overview (run, each agent's session, totals per model; no cost yet)
//   GET  …/board      the tasks with their history
//   GET  …/conversation?after=   a page after `after`; `next_after` 20 below the tail, as the server reads it
//   POST …/signals    {signal, task_id?, attempt?, note?, confirm?}: admin; 409 when the attempt moved on or the
//                     task is over, and the supervisor's reason for resuming a run out of budget; stop_now needs
//                     confirm: true; answers each agent's status after it, recorded as a signal.* message to the run; 503
//                     and nothing recorded when the agent is busy (MOCK_ENGINEERING_AGENT_BUSY=1)
//   POST …/messages   {to: 'conductor' | 'agent', agent?, text, thread_id?}: admin; 404 for an agent not in the run
// Every GET of the overview moves the run a little (the agents' ages), so polling shows it live.
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin (403 on the actions), like the agents routes.
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
  },
  agents: [
    agent('coordinator-0', 'coordinator', {
      status: 'waiting', step: 'board', microvm_state: 'suspended', microvm_age: 2520, heartbeat_age: 360,
      last_progress_at: epochMinutesAgo(30), recent_tools: ['read_issue', 'post_task', 'post_task', 'post_task'],
      microvm_seconds: 310, tokens: [{ model: 'model-large', input_tokens: 42_000, output_tokens: 6_100 }],
    }),
    agent('fixer-1', 'fixer', {
      task_id: 'task-fix-page-size', continuation: 1, step: 'board', microvm_state: 'running', microvm_age: 1500,
      heartbeat_age: 5, last_progress_at: epochMinutesAgo(1), recent_tools: ['read_file', 'run_tests', 'edit_file'],
      microvm_seconds: 1_420, tokens: [{ model: 'model-medium', input_tokens: 61_500, output_tokens: 9_800 }],
    }),
    agent('final-go-1', 'final-go', {
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
      lease: { agent: 'fixer-1', epoch: 2, expires: 0 }, result_keys: [], posted_by: 'coordinator-0',
      updated_by: 'fixer-1', updated_at: minutesAgo(1), spec_hash: 'a1',
      history: [
        { state: 'open', at: minutesAgo(30), by: 'coordinator-0', op: 'post', attempt: 0, result_keys: 0 },
        { state: 'claimed', at: minutesAgo(28), by: 'fixer-2', op: 'claim', attempt: 1, result_keys: 0 },
        { state: 'failed', at: minutesAgo(26), by: 'fixer-2', op: 'move', attempt: 1, result_keys: 0 },
        { state: 'claimed', at: minutesAgo(25), by: 'fixer-1', op: 'claim', attempt: 2, result_keys: 0 },
        { state: 'in_progress', at: minutesAgo(24), by: 'fixer-1', op: 'move', attempt: 2, result_keys: 0 },
      ],
    },
    {
      task_id: 'task-fix-sort', role: 'fixer', state: 'open', title: 'Sorting by date ignores the time zone',
      spec: { issue: 9 }, depth: 1, priority: 2, attempt: 0, parent_task: null, lease: null, result_keys: [],
      posted_by: 'coordinator-0', updated_by: 'coordinator-0', updated_at: minutesAgo(30), spec_hash: 'b2',
      history: [{ state: 'open', at: minutesAgo(30), by: 'coordinator-0', op: 'post', attempt: 0, result_keys: 0 }],
    },
    {
      task_id: 'task-fix-empty', role: 'fixer', state: 'done', title: 'An empty search shows an error',
      spec: { issue: 4 }, depth: 1, priority: 1, attempt: 1, parent_task: null, lease: null, result_keys: ['k1'],
      posted_by: 'coordinator-0', updated_by: 'fixer-3', updated_at: minutesAgo(14), spec_hash: 'c3',
      history: [
        { state: 'open', at: minutesAgo(30), by: 'coordinator-0', op: 'post', attempt: 0, result_keys: 0 },
        { state: 'done', at: minutesAgo(14), by: 'fixer-3', op: 'move', attempt: 1, result_keys: 1 },
      ],
    },
    {
      task_id: 'task-gate-empty', role: 'final-go', state: 'done', title: 'The gate record for the empty search fix',
      spec: { commit: 'abc1234' }, depth: 2, priority: 1, attempt: 1, parent_task: 'task-fix-empty',
      lease: { agent: 'final-go-1', epoch: 1, expires: 0 }, result_keys: ['k2'], posted_by: 'coordinator-0',
      updated_by: 'final-go-1', updated_at: minutesAgo(12), spec_hash: 'd4',
      history: [
        { state: 'claimed', at: minutesAgo(13), by: 'final-go-1', op: 'claim', attempt: 1, result_keys: 0 },
        { state: 'done', at: minutesAgo(12), by: 'final-go-1', op: 'move', attempt: 1, result_keys: 1 },
      ],
    },
  ],
  /** MOCK_ENGINEERING_OUT_OF_BUDGET=1: the run has spent its budget, so a resume is refused with the supervisor's reason. */
  outOfBudget: process.env.MOCK_ENGINEERING_OUT_OF_BUDGET === '1',
  /** MOCK_ENGINEERING_AGENT_BUSY=1: the supervisor answers busy for an agent signalled (503, nothing recorded). */
  agentBusy: process.env.MOCK_ENGINEERING_AGENT_BUSY === '1',
  messages: [],
};

function say(from, to, type, summary, { threadId = 't-run', taskId, at = new Date().toISOString() } = {}) {
  const seq = run.messages.length + 1;
  run.messages.push({
    seq, event_id: `evt-${seq}`, type, at,
    message: { schema: 'voc-msg/1', from, to, type, summary, thread_id: threadId, at, ...(taskId ? { task_id: taskId } : {}) },
  });
}

say({ kind: 'conductor', id: SAMPLE_RUN_ID }, { kind: 'run', id: SAMPLE_RUN_ID }, 'run.started', 'Started: three bugs to fix', { at: minutesAgo(42) });
say({ kind: 'system', id: 'board' }, { kind: 'role', id: 'fixer' }, 'task.posted', 'The last page shows one item too many', { taskId: 'task-fix-page-size', at: minutesAgo(30) });
say({ kind: 'agent', id: 'fixer-1' }, { kind: 'conductor', id: SAMPLE_RUN_ID }, 'msg.question', 'Is the page size inclusive of the last item?', { threadId: 't-page-size', at: minutesAgo(20) });
say({ kind: 'system', id: 'board' }, { kind: 'run', id: SAMPLE_RUN_ID }, 'task.done', 'An empty search shows an error: done', { taskId: 'task-fix-empty', at: minutesAgo(14) });

function overview() {
  for (const a of run.agents) {
    if (a.microvm_age !== null) a.microvm_age += 5;
    if (a.heartbeat_age !== null) a.heartbeat_age = a.agent === 'fixer-1' ? 5 : a.heartbeat_age + 5;
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
    totals: {
      messages: run.messages.length, microvm_seconds: run.agents.reduce((sum, a) => sum + a.microvm_seconds, 0),
      by_model: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)),
    },
  };
}

function conversation(url) {
  const after = Math.max(Number(url.searchParams.get('after')) || 0, 0);
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 50, 1), 200);
  const items = run.messages.filter((m) => m.seq > after).slice(0, limit);
  if (items.length === 0) return { items: [], next_after: after };
  const last = items.at(-1).seq;
  return { items, next_after: items.length === limit ? last : Math.max(after, last - TAIL_WINDOW) };
}

/** The agent a signal reaches, or the refusal: the task's holder at the attempt the person saw. */
function signalTarget(body) {
  if (body.task_id === undefined) {
    return body.attempt === undefined ? { kind: 'run', id: SAMPLE_RUN_ID } : [400, 'attempt goes with a task_id (a signal to the whole run has none)'];
  }
  const task = run.tasks.find((t) => t.task_id === body.task_id);
  if (!task) return [404, 'no such task in this run'];
  if (!task.lease || task.lease.epoch !== body.attempt || FINAL.has(task.state)) {
    return [409, 'This task has moved on since you looked: reload the run'];
  }
  return { kind: 'agent', id: task.lease.agent };
}

function signal(body) {
  if (!SIGNALS.includes(body?.signal)) return [400, { message: `signal is one of ${SIGNALS.join(', ')}` }];
  if (body.signal === 'stop_now' && body.confirm !== true) return [400, { message: 'stop_now stops without a checkpoint: send confirm: true' }];
  const target = signalTarget(body);
  if (Array.isArray(target)) return [target[0], { message: target[1] }];
  if (body.signal === 'resume' && run.outOfBudget) return [409, { message: `run ${SAMPLE_RUN_ID} has spent its budget: raise it before resuming` }];
  if (target.kind === 'agent' && run.agentBusy) return [503, { message: 'The agent is busy with another move: send the signal again' }];
  const reached = run.agents.filter((a) => target.kind === 'run' || a.agent === target.id);
  const next = { save: null, pause: 'pause_requested', resume: 'working', shutdown: 'pause_requested', stop_now: 'stopped' }[body.signal];
  for (const a of reached) if (next) a.status = next;
  const agents = Object.fromEntries(reached.map((a) => [a.agent, a.status]));
  const at = new Date().toISOString();
  const outcome = Object.entries(agents).map(([id, status]) => `${id} ${status}`).join(', ') || 'no agent yet';
  const whom = target.kind === 'agent' ? ` ${target.id}` : ' the run';
  say({ kind: 'human', id: 'mock-admin' }, { kind: 'run', id: SAMPLE_RUN_ID }, `signal.${body.signal}`,
    `alex asked${whom} to ${body.signal.replace('_', ' ')}: ${outcome}`, { threadId: 'signals', taskId: body.task_id, at });
  return [200, { signal: { event_id: `evt-${run.messages.length}`, signal: body.signal, target, attempt: body.attempt ?? 0, agents, at } }];
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

function routeGet(sub, url) {
  if (sub === undefined) return [200, overview()];
  if (sub === 'board') return [200, { tasks: run.tasks }];
  if (sub === 'conversation') return [200, conversation(url)];
  return [404, { message: 'Engineering run not found' }];
}

function routePost(sub, body) {
  if (!isAdmin()) return [403, { message: 'Admin access required' }];
  if (sub === 'signals') return signal(body ?? {});
  if (sub === 'messages') return answer(body ?? {});
  return [404, { message: 'Engineering run not found' }];
}

export function handleEngineeringRunRoutes(req, res, url, send, shared) {
  if (!url.pathname.startsWith(PREFIX)) return false;
  const [runId, sub, ...rest] = url.pathname.slice(PREFIX.length).split('/').map(decodeURIComponent);
  if (runId !== SAMPLE_RUN_ID || rest.length > 0) {
    send(404, { message: 'Engineering run not found' });
    return true;
  }
  if (req.method === 'GET') {
    const [status, payload] = routeGet(sub, url);
    send(status, payload);
    return true;
  }
  if (req.method !== 'POST') {
    send(405, { message: 'Method not allowed' });
    return true;
  }
  shared.collectJson(req, res, (body) => {
    const [status, payload] = routePost(sub, body);
    send(status, payload);
  });
  return true;
}
