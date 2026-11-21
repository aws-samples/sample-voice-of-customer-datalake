// An engineering run's monitor (docs/autonomous-agents.md "An engineering run"): the `/agents/engineering/<run_id>…`
// routes of agents_handler.py (lambda/engineering/monitor.py, views.py) in their wire shape, for one sample run
// (`/agents/engineering/01JDA7K3M9Q2R5T8V0W4X6Y1Z3`), its flow seeded in the workflow library by mock-server.js:
//   GET  …            the overview (run, each agent's session, totals per model; no cost yet)
//   GET  …/board      the tasks with their history
//   GET  …/conversation?after=   the 20 below `after` again, a page above it; `next_after` its last seq (the server's)
//   POST …/signals    {signal, task_id?, attempt?, note?, confirm?}: admin; 409 when the attempt moved on, the
//                     task is over or a Stop of the run is under way; stop_now needs confirm: true; since 7.51.02 it is
//                     sent through the start function (recorded on the run's own rows, never in the conversation) and
//                     answered {signal: {status: sent}}, the supervisor applying it just after (the agents' statuses
//                     change); an agent busy with another move (MOCK_ENGINEERING_AGENT_BUSY=1), or a Resume of a run out
//                     of budget, is left as it was
//   POST …/messages   {to: 'conductor' | 'agent', agent?, text, thread_id?}: admin; 404 for an agent not in the run
//   POST …/stop       {now?, confirm?} (7.50.03): admin; a person's Stop of the whole run (the start function's
//                     stop_run): with no agent at work it ends the run at once (its open tasks closed); else the agents
//                     save first (`stop` on the run, "Stopping…") and the run ends a few seconds later; now: true
//                     needs confirm: true and ends it at once; 409 once the run has ended
//   POST …/reactions  {}: admin; an ended run's reactions read asked for (202); 409 while it runs, 429 within the hour
//   GET  …/reports    the run's reports, each with its latest version
//   GET  …/reports/<level>/<subject>?version=   one version: {report, markdown}; 404 for no such report or version
//   POST /agents/engineering/runs   {workflow_id, connection, commit, language, goal, issue?, model?}: admin; a run's start, answered
//                     202 with the sample run (written, its coordinator's launch under way) (400 for a field off the server's rules);
//                     with `warnings` on a fine-grained token's connection that expires within 3 days (7.63.00)
//   GET|PUT /agents/engineering/settings   the administrators' hard cap {hard_cap, updated_at, updated_by}
//   GET  /agents/engineering/connections   the repository connections {connections, limit} (admin; never a secret)
//   PUT|DELETE /agents/engineering/connections/<id>   store one with its GitHub App credential, or keep the stored one
//   POST|DELETE /agents/engineering/connections/<id>/ci-attestation   attest its CI (every point), or withdraw it
//   …/agents/engineering/github-apps…   the deployment's GitHub Apps (7.45.00): mock-github-apps.js, over the
//                     connections here ('billing-api' goes through the sample App, a reference to its key)
//   GET  /agents/engineering/public-repositories, POST …/public-connections, POST …/connections/<id>/fork,
//   PUT …/connections/<id>/upstream   any public repository read only, and a fork of it (7.57.00): mock-public-repos.js,
//                     over the connections here (they start with the sample 'lint-kit' read only and its fork)
//   POST /agents/engineering/token-connections, PUT …/connections/<id>/token   a public repository connected with a
//                     person's fine-grained token (7.60.00): mock-token-connections.js, over the connections here (they
//                     start with the sample 'partner-sdk', its token expiring in 10 days)
//   POST …/go         {reason?} (7.60.00 in the SPA): a person's go on the sample run, {go: {by, at, created, reason}}:
//                     written once, answered as it stands after (created: false)
//   GET  /agents/engineering/issues-source, PUT …/connections/<id>/issues   the GitHub Issues source as the
//                     connections drive it (7.50.02): mock-issues-source.js, over the connections here
//                     (the server's field checks; 409 past the limit or for a repository change with live runs) | remove
//                     one (404 for an unknown id)
//   GET  /agents/engineering/spend?month=&by=&workflow=   the spend ledger's month, grouped (admin; 400 for a bad
//                     month, grouping or workflow id), from a few sample rows over this month and last
// Every GET of the overview moves the run a little (the agents' ages), so polling shows it live.
// MOCK_AGENTS_NON_ADMIN=1 makes the caller a non-admin: 403 on every route, as the server answers (admins only).
// 7.51.00, the run workspace (mock-engineering-run-workspace.js, from the shared fixture): the runs list (GET …/runs), an
// agent's thread and inspector tabs (…/agents/<agent>/{thread,changes,files,gate,memory}), the assertions, a person's
// steering (POST …/steer), an ended run's restart as a child run (POST …/restart; the ended run and its child are served
// too), the restart signal ({signal: restart, from: checkpoint | fresh, …, confirm: true}), and an answer to an agent
// only on the thread its own question opened (400 without a thread_id, 404 on another thread). 7.51.04: a run at a
// person whose orchestrator failed at its checkout (its overview and its orchestrator's thread, in the runs list).
// Wired into mock-server.js by handleDomainModules (before the agents routes, which would read `engineering` as an
// agent id).

import { handleGitHubAppRoutes } from './mock-github-apps.js';
import { handleIssuesSourceRoutes } from './mock-issues-source.js';
import { handlePublicRepositoryRoutes, sampleContributions } from './mock-public-repos.js';
import { handleTokenConnectionRoutes, sampleTokenConnection } from './mock-token-connections.js';
import {
  CHILD_RUN_ID, ENDED_RUN_ID, FAILED_RUN_ID, agentRoute, assertions, failedRunThread, otherOverview, restart, runsList, steer,
  workspaceOverview,
} from './mock-engineering-run-workspace.js';

export const SAMPLE_RUN_ID = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3';
export const SAMPLE_FLOW_ID = 'wf_7c2d9e41a0b3';
const PREFIX = '/agents/engineering/';
const SIGNALS = ['save', 'pause', 'resume', 'shutdown', 'stop_now', 'restart'];
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
    // (7.60.00: the connection it started on, as the overview names it)
    connection: 'storefront',
    flow: SAMPLE_FLOW_ID, status: 'running', started_at: minutesAgo(42), ended_at: null, waiting_at: '', stop: null,
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
  /** MOCK_ENGINEERING_OUT_OF_BUDGET=1: the run has spent its budget, so the supervisor leaves a Resume undone. */
  outOfBudget: process.env.MOCK_ENGINEERING_OUT_OF_BUDGET === '1',
  /** MOCK_ENGINEERING_AGENT_BUSY=1: the supervisor finds an agent signalled busy with another move, and leaves it as it
   *  was (the signal was sent: the person sends it again). */
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

/** The run ended by a person's Stop: its agents stopped, its open tasks closed (`failed`, a `stop` move). */
function endStopped() {
  const at = new Date().toISOString();
  const closed = [];
  for (const task of run.tasks) {
    if (FINAL.has(task.state)) continue;
    task.history.push({ state: 'failed', at, by: 'human:mock-admin', op: 'stop', attempt: task.attempt, result_keys: 0 });
    Object.assign(task, { state: 'failed', lease: null, updated_by: 'human:mock-admin', updated_at: at });
    closed.push(task.task_id);
  }
  for (const a of run.agents) if (!['done', 'failed', 'stopped'].includes(a.status)) a.status = 'stopped';
  Object.assign(run.meta, { status: 'stopped', ended_at: at });
  say({ kind: 'supervisor', id: 'supervisor' }, { kind: 'run', id: SAMPLE_RUN_ID }, 'run.health',
    `Stopped from the run monitor: ${run.agents.length} session(s) ended, ${closed.length} task(s) closed.`);
  return closed;
}

/** A person's Stop (`POST …/stop`), as voc-engineering-start answers it (lambda/engineering/runtime/stop.py). */
function stopRun(body) {
  if (run.meta.ended_at !== null) return [409, { message: 'This run has ended' }];
  if (body.now !== undefined && typeof body.now !== 'boolean') return [400, { message: 'now is true (Stop now, without saving) or false (Stop: save, then stop)' }];
  if (body.now === true && body.confirm !== true) return [400, { message: 'Stop now stops without a checkpoint: send confirm: true' }];
  const mode = body.now === true ? 'stop_now' : 'stop';
  const saving = mode === 'stop_now' ? [] : run.agents.filter((a) => ['booting', 'working', 'pause_requested'].includes(a.status)).map((a) => a.agent);
  const answer = { run_id: SAMPLE_RUN_ID, mode, holds_released: [], already: false, fell_back: false, agents: {}, agent_run: null };
  if (saving.length === 0) return [200, { stop: { ...answer, status: 'stopped', tasks_closed: endStopped(), saving: [] } }];
  run.meta.stop = { mode, requested_at: new Date().toISOString() };
  run.stopDueAt = Date.now() + 8000;
  for (const a of run.agents) if (saving.includes(a.agent)) a.status = 'pause_requested';
  return [200, { stop: { ...answer, status: 'stopping', tasks_closed: [], saving } }];
}

function overview() {
  // A Stop whose agents were saving ends a few seconds later (the supervisor's tick, once they have).
  if (run.meta.stop !== null && run.meta.ended_at === null && Date.now() >= (run.stopDueAt ?? 0)) endStopped();
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
  const workspace = workspaceOverview(run.agents);
  return {
    run: { ...run.meta, ...workspace.run },
    agents: workspace.agents,
    lanes: workspace.lanes, gates: workspace.gates, children: workspace.children,
    // The dev mock plays a stack that names the bus to the Agents API (steering and answers) and the start function
    // (the signals since 7.51.02, the Stop since 7.50.03), as the server says.
    steer_available: true,
    signals_available: true,
    stop_available: true,
    totals: {
      messages: run.messages.length, microvm_seconds: run.agents.reduce((sum, a) => sum + a.microvm_seconds, 0),
      by_model: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)),
    },
    reactions: SAMPLE_REACTIONS,
  };
}

// The latest read of people's reactions to the run's pull request (lambda/engineering/learning/reactions.py view):
// kept only for people with write access, bodies redacted and plain text.
const SAMPLE_REACTIONS = {
  schema: 'voc-reactions/1',
  pull_request: { host: 'github', number: 42, url: 'https://github.com/example-org/storefront/pull/42' },
  state: 'merged', merged_at: '2026-11-12T10:00:00Z', merge_commit: 'a'.repeat(40),
  items: [
    { kind: 'review', state: 'approved', author: 'robin-maintainer', at: '2026-11-12T09:40:00Z', body: 'Looks right now.' },
    { kind: 'review_comment', state: '', author: 'robin-maintainer', at: '2026-11-12T09:10:00Z',
      body: 'This sort is not stable for equal prices.' },
    { kind: 'review', state: 'changes_requested', author: 'robin-maintainer', at: '2026-11-12T09:05:00Z',
      body: 'Please keep the old order for ties.' },
    { kind: 'comment', state: '', author: 'sam-collaborator', at: '2026-11-11T16:00:00Z', body: 'Thanks for the fix.' },
  ],
  dropped: { outsiders: 2, bots: 1 },
  reverted: false, revert_commit: '',
  edits_after_merge: { people_commits: 1, files: ['src/sort.ts'], paths_read: 3, paths_total: 3 },
  more: false, read_at: '2026-11-13T10:00:00.000000Z', asked_by: 'schedule',
  counts: { approved: 1, changes_requested: 1, commented: 0, review_comments: 1, comments: 1 },
  reviewers: [{ reviewer: 'robin-maintainer', state: 'approved', at: '2026-11-12T09:40:00Z' }],
};
let reactionsAskedAt = 0;

/** An administrator's hand trigger (`POST …/reactions`): 409 while the run is under way, at most once an hour. */
function askReactions() {
  if (run.meta.ended_at === null) return [409, { message: "The run has not ended: its pull request's reactions are read once it has." }];
  const now = Date.now();
  if (now - reactionsAskedAt < 3_600_000) {
    return [429, { error: "This run's reactions were asked for in this hour already: ask again later.", retry_after: 1800 }];
  }
  reactionsAskedAt = now;
  return [202, { reactions: { status: 'asked' } }];
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

/** Why a signal's body is refused (the server's parse_signal), or null. */
function signalRefusal(body) {
  if (!SIGNALS.includes(body?.signal)) return `signal is one of ${SIGNALS.join(', ')}`;
  if (body.signal === 'stop_now' && body.confirm !== true) return 'stop_now stops without a checkpoint: send confirm: true';
  if (body.signal !== 'restart') return null;
  if (!['checkpoint', 'fresh'].includes(body.from)) return "a restart's from is checkpoint or fresh";
  if (body.confirm !== true) return "a restart ends the agent's session: send confirm: true";
  return body.task_id === undefined ? "a restart is an agent's: name its task_id and the attempt you saw" : null;
}

function signal(body) {
  const refused = signalRefusal(body);
  if (refused) return [400, { message: refused }];
  const target = signalTarget(body);
  if (Array.isArray(target)) return [target[0], { message: target[1] }];
  if (run.meta.stop !== null && run.meta.ended_at === null) {
    return [409, { message: `run ${SAMPLE_RUN_ID} is being stopped: it takes no other signal` }];
  }
  // Sent through the start function (recorded on the run's own rows), then applied by the supervisor just after: an
  // agent busy with another move, or a Resume of a run out of budget, is left as it was.
  const at = new Date().toISOString();
  const left = (target.kind === 'agent' && run.agentBusy) || (body.signal === 'resume' && run.outOfBudget);
  const next = { save: null, pause: 'pause_requested', resume: 'working', shutdown: 'pause_requested', stop_now: 'stopped',
    restart: 'booting' }[body.signal];
  if (!left && next) for (const a of run.agents) if (target.kind === 'run' || a.agent === target.id) a.status = next;
  return [200, { signal: { signal: body.signal, target, attempt: body.attempt ?? 0, status: 'sent', agents: {}, applied: {}, at } }];
}

function answer(body) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (text === '' || Buffer.byteLength(text) > MAX_ANSWER_BYTES) return [400, { message: `text is what you say, at most ${MAX_ANSWER_BYTES} bytes` }];
  const to = body.to === 'conductor' ? { kind: 'conductor', id: SAMPLE_RUN_ID } : { kind: 'agent', id: body.agent };
  if (body.to !== 'conductor' && !(body.to === 'agent' && typeof body.agent === 'string')) {
    return [400, { message: "to is 'conductor', or 'agent' with the agent's id in agent" }];
  }
  if (to.kind === 'agent' && body.thread_id === undefined) {
    return [400, { message: 'an answer to an agent names the thread_id of its question (to steer it, steer the run)' }];
  }
  if (to.kind === 'agent' && !run.agents.some((a) => a.agent === to.id)) return [404, { message: 'no such agent in this run' }];
  if (body.thread_id !== undefined && !ID.test(String(body.thread_id))) return [400, { message: 'thread_id is the id of the thread you answer' }];
  const asked = run.messages.some((m) => m.type === 'msg.question' && m.message.from.id === to.id && m.message.thread_id === body.thread_id);
  if (to.kind === 'agent' && !asked) {
    return [404, { message: `agent ${to.id} asked no question on this thread: an answer to an agent replies on the thread its own question opened` }];
  }
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
  if (sub === 'agents' && rest.length >= 2) return agentRoute(rest[0], rest.slice(1), url, run.agents.map((a) => a.agent));
  if (rest.length > 0) return [404, { message: 'Engineering run not found' }];
  if (sub === undefined) return [200, overview()];
  if (sub === 'board') return [200, { tasks: run.tasks }];
  if (sub === 'conversation') return [200, conversation(url)];
  if (sub === 'assertions') return assertions();
  return [404, { message: 'Engineering run not found' }];
}

/** The run's own actions (`POST …/<run>/<action>`), each on its body. */
/** A person's go on the sample run (GO#person): written once, then answered as it stands. */
let personGo = null;

function giveGo(body) {
  if (run.meta.ended_at !== null) return [409, { message: 'the run is not live: it takes no go' }];
  if (personGo !== null) return [200, { go: { ...personGo, created: false } }];
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  personGo = { by: 'person:sub-admin-demo', at: new Date().toISOString(), reason };
  return [200, { go: { ...personGo, created: true } }];
}

const RUN_POSTS = {
  go: (body) => giveGo(body),
  signals: (body) => signal(body),
  messages: (body) => answer(body),
  stop: (body) => stopRun(body),
  reactions: () => askReactions(),
  steer: (body) => (run.meta.ended_at === null
    ? steer(body, run.agents.map((a) => a.agent), say, SAMPLE_RUN_ID)
    : [409, { message: 'This run has ended' }]),
  restart: (body) => restart(SAMPLE_RUN_ID, body, run.meta.ended_at === null),
};

function routePost(sub, rest, body) {
  if (!isAdmin()) return [403, { message: 'Admin access required' }];
  if (rest.length > 0 || !Object.hasOwn(RUN_POSTS, sub)) return [404, { message: 'Engineering run not found' }];
  return RUN_POSTS[sub](body ?? {});
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
// The engineering connectors' `connections` module's rules. The GitHub App's private key and the GitLab project access
// token are taken and never answered: a connection says only whether its credential is set, and the App's ids or the
// token's expiry. A save without a credential keeps the stored one (a new connection, or a new host or repository,
// needs it); a live run on 'storefront' refuses its repository change (409). The demo's GitLab token (the mock checks
// no host) expires 60 days after its save; 'docs-site's stored one within the warning's 30 days.
const CONNECTION_PATH = /^\/agents\/engineering\/connections(?:\/([^/]*)(\/ci-attestation)?)?$/;
const CONNECTION_LIMIT = 20;
const CONNECTION_FIELDS = ['host', 'repository', 'default_branch', 'credential'];
const CREDENTIAL_FIELDS = ['app_id', 'installation_id', 'private_key'];
const LIVE_RUN_CONNECTIONS = new Set(['storefront']);
/** A calendar day `days` from today (UTC), `YYYY-MM-DD`: a GitLab token's expiry. */
const dayAhead = (days) => new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
const connections = new Map([['storefront', {
  connection_id: 'storefront', host: 'github', repository: 'example-org/storefront', default_branch: 'main',
  credential: { kind: 'app', set: true, app_id: '104729', installation_id: '7919001', expires_at: null },
  created_at: minutesAgo(60 * 24 * 9), created_by: 'admin-demo', updated_at: minutesAgo(60 * 24 * 2), updated_by: 'admin-demo',
  version: 3, repository_private: null,
}], ['billing-api', {
  // (saved by the sample GitHub App's installation, mock-github-apps.js: a reference to the App's key, stored once)
  connection_id: 'billing-api', host: 'github', repository: 'example-org/billing-api', default_branch: 'main',
  credential: { kind: 'app_reference', set: true, app_id: '271828', installation_id: '31415926', expires_at: null },
  created_at: minutesAgo(60 * 24 * 5), created_by: 'admin-demo', updated_at: minutesAgo(60 * 24 * 5), updated_by: 'admin-demo',
  version: 1, repository_private: true,
}], ['docs-site', {
  connection_id: 'docs-site', host: 'gitlab', repository: 'example-group/web/docs-site', default_branch: 'main',
  credential: { kind: 'project_token', set: true, app_id: null, installation_id: null, expires_at: dayAhead(12), expires_in_days: 12 },
  created_at: minutesAgo(60 * 24 * 340), created_by: 'admin-demo', updated_at: minutesAgo(60 * 24 * 340), updated_by: 'admin-demo',
  version: 1, repository_private: null,
}]]);
for (const sample of [...sampleContributions(), sampleTokenConnection()]) connections.set(sample.connection_id, sample);
/** Whether `id` names a stored connection (a removed one is gone from the map): the readiness preview's rule. */
export const isStoredConnection = (id) => connections.has(id);
const DIGITS = /^[1-9]\d{0,19}$/;
const GITLAB_TOKEN = /^glpat-[A-Za-z0-9_.-]{20,300}$/;
const PROJECT_SEGMENT = /^\w[\w.-]*$/;
const PEM = /^-----BEGIN (RSA |)PRIVATE KEY-----\n(?:[A-Za-z0-9+/=]{1,76}\n)+-----END \1PRIVATE KEY-----$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

/** A GitLab save's credential state (never the token), or the 400 message of a bad one. */
function tokenState(credential) {
  if (typeof credential !== 'object' || credential === null || Object.keys(credential).join() !== 'token'
    || typeof credential.token !== 'string' || !GITLAB_TOKEN.test(credential.token)) {
    return 'credential is {token}: the GitLab project access token (glpat-…)';
  }
  return { kind: 'project_token', set: true, app_id: null, installation_id: null, expires_at: dayAhead(60), expires_in_days: 60 };
}

/** The stored credential's state for a save's credential (never the key), or the 400 message of a bad one. */
function credentialState(credential, host) {
  if (host === 'gitlab') return tokenState(credential);
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
  return { kind: 'app', set: true, app_id: String(appId), installation_id: String(installationId), expires_at: null };
}

/** A GitLab project's path: `group/project`, nested groups allowed (at most 21 segments, 255 characters). */
function isProjectPath(path) {
  if (typeof path !== 'string') return false;
  const segments = path.split('/');
  return path.length <= 255 && segments.length >= 2 && segments.length <= 21
    && segments.every((part) => PROJECT_SEGMENT.test(part) && part !== '.' && part !== '..'
      && !part.endsWith('.git') && !part.endsWith('.atom'));
}

function isGitHubRepository(repository) {
  const [owner = '', name = '', ...rest] = typeof repository === 'string' ? repository.split('/') : [];
  return rest.length === 0 && /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner) && /^[A-Za-z0-9._-]{1,100}$/.test(name)
    && name !== '.' && name !== '..';
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
  if (body.host !== 'github' && body.host !== 'gitlab') return 'host is github or gitlab';
  if (body.host === 'gitlab' && !isProjectPath(body.repository)) {
    return 'repository is the GitLab project\'s path (group/project, nested groups allowed)';
  }
  if (body.host === 'github' && !isGitHubRepository(body.repository)) return 'repository is the GitHub repository as owner/name';
  if (!isBranch(body.default_branch)) return 'default_branch is a branch name git accepts, not an agent\'s voc-agent/ branch';
  return null;
}

/** The credential a save leaves stored, or the 400 message: a save without one keeps the stored one. */
function savedCredential(before, body) {
  if (body.credential !== undefined && body.credential !== null) return credentialState(body.credential, body.host);
  if (before === undefined) return 'credential is needed to add a connection';
  if (before.repository !== body.repository || before.host !== body.host || !before.credential.set) {
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
  // (a host change is a move too, as the server's connections.py `_moved` has it)
  const moved = before !== undefined && (before.repository !== body.repository || (before.host ?? 'github') !== body.host);
  if (moved && LIVE_RUN_CONNECTIONS.has(id)) {
    return [409, { message: '1 run(s) of this connection are live: the repository changes once they end (or stop them first)' }];
  }
  const now = new Date().toISOString();
  const connection = {
    connection_id: id, host: body.host, repository: body.repository, default_branch: body.default_branch, credential,
    repository_private: moved || before === undefined ? null : before.repository_private,
    created_at: before?.created_at ?? now, created_by: before?.created_by ?? 'admin-demo', updated_at: now, updated_by: 'admin-demo',
    version: (before?.version ?? 0) + 1,
  };
  connections.set(id, connection);
  if (moved) voidAttestation(id, 'repository_changed');
  return [200, { connection: withAttestation(connection), created: before === undefined }];
}

// ── A connection's CI attestation (POST|DELETE …/connections/<id>/ci-attestation; connectors/attestations.py) ──
// Every point of the setup guide confirmed, or 400; the newest version answered with the connection; a repository
// change or a removal voids it.
const CI_POINTS = ['protected_secrets', 'read_only_token', 'oidc_pinned', 'no_self_hosted_runner',
  'no_privileged_pull_request', 'branch_rules'];
const attestations = new Map([['storefront', {
  version: 1, state: 'attested', repository: 'example-org/storefront', points: CI_POINTS, by: 'admin-demo',
  at: minutesAgo(60 * 24), reason: null, cause: null,
}]]);

const withAttestation = (connection) => ({ ...connection, ci_attestation: attestations.get(connection.connection_id) ?? null });

/** The connection's next version: `state`, for its repository now, by the demo administrator. */
function nextVersion(id, state, extra) {
  const newest = attestations.get(id);
  const version = {
    version: (newest?.version ?? 0) + 1, state, repository: connections.get(id)?.repository ?? newest?.repository ?? '',
    points: [], by: 'admin-demo', at: new Date().toISOString(), reason: null, cause: null, ...extra,
  };
  attestations.set(id, version);
  return version;
}

function voidAttestation(id, cause) {
  if (attestations.get(id)?.state === 'attested') nextVersion(id, 'voided', { cause });
}

function attest(id, body) {
  if (!connections.has(id)) return [404, { message: 'Connection not found' }];
  const points = body?.points;
  const fields = ['points', 'repository', 'version', 'reason'];
  if (!Array.isArray(points) || Object.keys(body).some((key) => !fields.includes(key))
    || typeof body.repository !== 'string' || !Number.isInteger(body.version)) {
    return [400, { message: 'the body is {points, repository, version, reason?}: the setup guide\'s points confirmed' }];
  }
  const missing = CI_POINTS.filter((point) => !points.includes(point));
  if (missing.length > 0 || points.some((point) => !CI_POINTS.includes(point))) {
    return [400, { message: `every point of the setup guide is confirmed: not yet ${missing.join(', ')}` }];
  }
  // (the repository and version the page reviewed: another administrator's change meanwhile refuses it)
  const connection = connections.get(id);
  if (connection.repository !== body.repository || connection.version !== body.version) {
    return [409, { message: 'the connection changed meanwhile: reload it, review its repository again and try again' }];
  }
  const newest = attestations.get(id);
  if (newest?.state === 'attested' && newest.repository === connection.repository) {
    return [200, { attestation: newest, created: false, connection_version: connection.version }];
  }
  const reason = typeof body.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : null;
  connection.version += 1;
  return [200, { attestation: nextVersion(id, 'attested', { points: CI_POINTS, reason }), created: true,
    connection_version: connection.version }];
}

function attestationRoute(req, res, send, shared, id) {
  if (req.method === 'POST') return shared.collectJson(req, res, (body) => send(...attest(id, body)));
  if (req.method !== 'DELETE') return send(405, { message: 'Method not allowed' });
  if (!connections.has(id) || attestations.get(id)?.state !== 'attested') {
    return send(404, { message: 'no CI attestation holds for this connection' });
  }
  return shared.collectJson(req, res, (body) => {
    const reason = typeof body?.reason === 'string' && body.reason.trim() !== '' ? body.reason.trim() : null;
    connections.get(id).version += 1;
    nextVersion(id, 'withdrawn', { reason });
    send(200, { withdrawn: true });
  });
}

function connectionsRoute(req, res, send, shared, id, ciAttestation) {
  if (!isAdmin()) return send(403, { message: 'Admin access required' });
  if (id === undefined) {
    if (req.method !== 'GET') return send(405, { message: 'Method not allowed' });
    return send(200, { connections: [...connections.values()].map(withAttestation), limit: CONNECTION_LIMIT });
  }
  if (ciAttestation) return attestationRoute(req, res, send, shared, id);
  if (req.method === 'DELETE') {
    voidAttestation(id, 'connection_removed');
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
  // (`issue`, optional since 7.09.00: a whole number from 1, as the server takes it)
  const issueOk = fields.issue === undefined
    || (Number.isInteger(fields.issue) && fields.issue >= 1 && fields.issue <= 2147483647);
  // (`model`, optional since 7.58.00: one model for every role of the run, of the shape the server takes)
  const modelOk = fields.model === undefined || fields.model === null
    || (typeof fields.model === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(fields.model.trim())
      && !fields.model.includes('//'));
  const wellFormed = Object.keys(fields).every((key) => START_FIELDS.includes(key) || key === 'issue' || key === 'model')
    && START_FIELDS.every((key) => typeof fields[key] === 'string') && issueOk;
  if (!wellFormed) return [400, { message: 'the body is {workflow_id, connection, commit, language, goal, issue?, model?}, each a string but issue' }];
  if (!modelOk) return [400, { message: 'a model is auto, opus, sonnet or haiku, or a model id (letters, digits and ._:/-, at most 128 characters, no spaces, no URL)' }];
  const failed = START_CHECKS.find(([passes]) => !passes(fields));
  if (failed) return [400, { message: failed[1] }];
  // 202, as the server: the run is written and its coordinator's launch under way; (7.63.00) with `warnings` when the
  // connection is a fine-grained token's that expires within 3 days (the server's token_warning).
  const warning = tokenWarning(connections.get(fields.connection.trim()));
  return [202, { run: { run_id: SAMPLE_RUN_ID, status: 'active', workflow_id: fields.workflow_id, started_by: 'sub-admin-demo' },
    ...(warning === null ? {} : { warnings: [warning] }) }];
}

/** What a start says beside a run on a fine-grained connection whose token expires in 1 to 3 days, else null. */
function tokenWarning(connection) {
  const left = connection?.kind === 'fine_grained' ? connection.credential?.expires_in_days : undefined;
  if (typeof left !== 'number' || left <= 0 || left > 3) return null;
  return `The connection's fine-grained token expires in ${left} day${left === 1 ? '' : 's'}: its owner replaces it `
    + "under Agents → Connections before then, or the run's push is refused.";
}

function startRoute(req, res, send, shared, url) {
  if (req.method === 'GET') send(...(isAdmin() ? runsList(url) : [403, { message: 'Admin access required' }]));
  else if (req.method !== 'POST') send(405, { message: 'Method not allowed' });
  else if (!isAdmin()) send(403, { message: 'Admin access required' });
  else shared.collectJson(req, res, (body) => send(...startRun(body)));
}

function spendRoute(req, res, send, _shared, url) {
  if (req.method !== 'GET') send(405, { message: 'Method not allowed' });
  else if (isAdmin()) send(...monthSpend(url));
  else send(403, { message: 'Admin access required' });
}

const UPSTREAM_TITLE = 'Fix the lint rule that flags valid optional chaining';
const UPSTREAM_DESCRIPTION = [
  '## What this changes', '',
  'The `no-unsafe-chain` rule reported `a?.b?.()` as unsafe. It now reads the optional call as guarded.', '',
  '## How it was checked', '',
  '- The rule\'s tests: 48 passed, 3 added for optional calls.',
  '- The repository\'s own CI commands, run on the fork\'s branch.', '',
  '## Why', '',
  'Customer feedback: the false positive blocked teams adopting the kit.', '',
  'Prepared by engineering agents; reviewed by its owner before this pull request.',
].join('\n');

/** The compare page with the pull request prefilled; its body shortened, the way the broker shortens a long one. */
function compareUrl(branch) {
  const query = new URLSearchParams({ expand: '1', title: UPSTREAM_TITLE, body: `${UPSTREAM_DESCRIPTION.slice(0, 120)}…` });
  return `https://github.com/open-tools/lint-kit/compare/main...admin-demo:lint-kit:${branch}?${query}`;
}

/**
 * The runs as ones on a fork connection would end (7.57.00), with the broker's upstream pull request on their record:
 * the ended run's one click away (`link`: the person clicks Create on GitHub; the body in the link is shortened, the
 * full description copied from the run page), and its child's opened by the app as its owner (authorized).
 */
const UPSTREAMS = {
  [ENDED_RUN_ID]: () => ({
    state: 'link', upstream: 'open-tools/lint-kit', number: null, url: null, as: null,
    reason: 'The app opens it for you once you authorize it (Authorize as me). '
      + 'Open it with one click: you create it on GitHub, from your fork.',
    at: new Date(Date.now() - 3_600_000).toISOString(), compare_url: compareUrl(`voc-agent/${ENDED_RUN_ID}/fix`),
    title: UPSTREAM_TITLE, description: UPSTREAM_DESCRIPTION,
  }),
  [CHILD_RUN_ID]: () => ({
    state: 'opened', upstream: 'open-tools/lint-kit', number: 128, url: 'https://github.com/open-tools/lint-kit/pull/128',
    as: 'admin-demo', reason: null, at: new Date(Date.now() - 1_800_000).toISOString(), compare_url: null, title: null,
    description: null,
  }),
};

function withUpstream(overview, runId) {
  const upstream = UPSTREAMS[runId];
  return upstream === undefined ? overview : { ...overview, run: { ...overview.run, upstream_pull_request: upstream() } };
}

/** The ended run and its child (7.51.00): their overviews, and the ended run's restart (the child is live: 409). */
function otherRunRoute(req, res, send, shared, runId, sub) {
  if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (req.method === 'GET' && sub === undefined) send(200, withUpstream(otherOverview(runId), runId));
  else if (req.method === 'POST' && sub === 'restart') {
    shared.collectJson(req, res, (body) => send(...restart(runId, body ?? {}, runId === CHILD_RUN_ID)));
  } else send(404, { message: 'Engineering run not found' });
}

/** (7.51.04) The failed run's reads (an admin's): its overview and its orchestrator's thread; nothing else. */
function failedRunRoute(req, send, sub, rest) {
  if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (req.method === 'GET' && sub === undefined) send(200, otherOverview(FAILED_RUN_ID));
  else if (req.method === 'GET' && sub === 'agents' && rest.length === 2 && rest[1] === 'thread') send(...failedRunThread(rest[0]));
  else send(404, { message: 'Engineering run not found' });
}

/** The routes of one exact path under the prefix. */
const EXACT_ROUTES = { runs: startRoute, settings: settingsRoute, spend: spendRoute };

/** The domain modules over the connections here (the GitHub Apps, the Issues source, the public repositories). */
function handleConnectionModules(req, res, url, send, shared) {
  const over = { connections, connectionLimit: CONNECTION_LIMIT, isAdmin };
  return handleGitHubAppRoutes(req, res, url, send, shared, over) || handleIssuesSourceRoutes(req, res, url, send, shared, over)
    || handlePublicRepositoryRoutes(req, res, url, send, shared, over) || handleTokenConnectionRoutes(req, res, url, send, shared, over);
}

export function handleEngineeringRunRoutes(req, res, url, send, shared) {
  if (!url.pathname.startsWith(PREFIX)) return false;
  if (handleConnectionModules(req, res, url, send, shared)) return true;
  const connection = CONNECTION_PATH.exec(url.pathname);
  if (connection) {
    connectionsRoute(req, res, send, shared, connection[1] === undefined ? undefined : decodeURIComponent(connection[1]),
      connection[2] !== undefined);
    return true;
  }
  const exact = url.pathname.slice(PREFIX.length);
  if (Object.hasOwn(EXACT_ROUTES, exact)) {
    EXACT_ROUTES[exact](req, res, send, shared, url);
    return true;
  }
  const [runId, sub, ...rest] = url.pathname.slice(PREFIX.length).split('/').map(decodeURIComponent);
  const nested = req.method === 'GET' && ['reports', 'agents'].includes(sub);
  if ([ENDED_RUN_ID, CHILD_RUN_ID].includes(runId) && rest.length === 0) {
    otherRunRoute(req, res, send, shared, runId, sub);
    return true;
  }
  if (runId === FAILED_RUN_ID) {
    failedRunRoute(req, send, sub, rest);
    return true;
  }
  if (runId !== SAMPLE_RUN_ID || (rest.length > 0 && !nested)) send(404, { message: 'Engineering run not found' });
  else sampleRunRoute(req, res, url, send, shared, sub, rest);
  return true;
}

/** The sample run's own routes (`…/<SAMPLE_RUN_ID>/<sub>/…`), for an admin: its reads and its actions. */
function sampleRunRoute(req, res, url, send, shared, sub, rest) {
  if (!isAdmin()) send(403, { message: 'Admin access required' });
  else if (req.method === 'GET') send(...routeGet(sub, rest, url));
  else if (req.method !== 'POST') send(405, { message: 'Method not allowed' });
  else shared.collectJson(req, res, (body) => send(...routePost(sub, rest, body)));
}
