// The run workspace (7.51.00: shared/agents_engineering_run_routes.py, lambda/engineering/views_thread.py,
// views_inspector.py, run_overview.py) for the dev mock's sample run, served from the shared fixture
// (src/test/engineeringRunWorkspace.json): the server's own answers for the same run, which a Python test holds to the
// real routes, so the mock never drifts from them. Wired by mock-engineering-runs.js:
//   GET  /agents/engineering/runs?month=&flow=&status=   the month's runs, newest first (400 for a bad month or status)
//   GET  …/<run>/agents/<agent>/thread?after=&limit=     the fixer's thread: its start, the page after it, its tail
//                                                       (the overview's transcript_cursor); an empty page for the others
//   GET  …/<run>/agents/<agent>/thread/<ref>             the run tool call with its result (404 for another ref)
//   GET  …/<run>/agents/<agent>/changes?source=          the fixer's submitted patch or a checkpoint's, with the links
//   GET  …/<run>/agents/<agent>/changes/file?key=&path=  one file of the submitted patch
//   GET  …/<run>/agents/<agent>/{files,gate,memory}      the fixer's files and memory, the gate runner's gate
//   GET  …/<run>/assertions                              the gate step's assertions
//   POST …/<run>/steer {text, about?, thread_id?}        202; recorded as msg.steer to the conductor
//   POST …/<run>/restart {mode, agents?, base, confirm}  409 for the live sample run; 202 a child for the ended run
//   GET  /agents/engineering/<ended run> and <child run>  their overviews (a parent and its child)
import { readFileSync } from 'node:fs';

const FIXTURE = JSON.parse(readFileSync(new URL('./src/test/engineeringRunWorkspace.json', import.meta.url), 'utf8'));
const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;
const STATUSES = ['active', 'needs_human', 'done', 'failed', 'stopped'];
const SOURCES = ['submitted', 'checkpoint'];
const MAX_STEER_BYTES = 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const answerOf = (name) => structuredClone(FIXTURE[name].answer);
/** The cursor that opens a thread at its tail (the server's views_thread.TAIL: every agent's transcript_cursor). */
const TAIL = FIXTURE.overview.answer.agents.find((agent) => agent.agent === FIXTURE.agent).transcript_cursor;

/** The runs the mock serves beyond the sample run: the ended one and its child (their overviews, a restart). */
export const ENDED_RUN_ID = FIXTURE.ended_run_id;
export const CHILD_RUN_ID = FIXTURE.child_run_id;

export function runsList(url) {
  const month = url.searchParams.get('month');
  const status = url.searchParams.get('status');
  const flow = url.searchParams.get('flow');
  if (month !== null && !MONTH.test(month)) return [400, { message: 'month is yyyy-mm' }];
  if (status !== null && !STATUSES.includes(status)) return [400, { message: `status is one of ${STATUSES.join(', ')}` }];
  const runs = answerOf('runs').runs.filter((run) => (!status || run.status === status) && (!flow || run.flow === flow));
  return [200, { runs, next: null }];
}

/** An ended run's or a child run's overview (the fixture's). */
export function otherOverview(runId) {
  return answerOf(runId === ENDED_RUN_ID ? 'ended_overview' : 'child_overview');
}

/** What the run workspace adds to the sample run's overview: per agent (by id), the run's cost, lanes, gates. */
export function workspaceOverview(agents) {
  const fixture = answerOf('overview');
  const extras = new Map(fixture.agents.map((agent) => [agent.agent, agent]));
  const status = new Map(agents.map((agent) => [agent.agent, agent.status]));
  const lanes = Object.fromEntries(Object.entries(fixture.lanes).map(([step, lane]) =>
    [step, lane.map((entry) => ({ ...entry, status: status.get(entry.agent) ?? entry.status }))]));
  const pick = ({ cost_usd, learn_cost_usd, cost_cap_usd, parent, manifest }) => ({ cost_usd, learn_cost_usd, cost_cap_usd, parent, manifest });
  return {
    run: pick(fixture.run),
    agents: agents.map((agent) => {
      const known = extras.get(agent.agent);
      return { cost_usd: known?.cost_usd ?? 0, attempt: known?.attempt ?? 1, commit: known?.commit ?? null,
        skill_label: known?.skill_label ?? null, model: known?.model ?? null, transcript_cursor: known?.transcript_cursor ?? null,
        ...agent };
    }),
    lanes, gates: fixture.gates, children: fixture.children,
  };
}

function thread(agent, rest, url) {
  if (rest.length === 1) {
    const item = answerOf('thread_item');
    return agent === FIXTURE.agent && rest[0] === item.ref ? [200, item] : [404, { message: 'No such item in this thread' }];
  }
  if (agent !== FIXTURE.agent) return [200, { items: [], next: TAIL, done: false }];
  const after = url.searchParams.get('after');
  if (after === null) return [200, answerOf('thread')];
  if (after === TAIL) return [200, answerOf('thread_tail')];
  // (the page after the first, and every poll after it: the server re-reads the conversation's window)
  return [200, answerOf('thread_next')];
}

function changes(agent, rest, url) {
  if (rest[0] === 'file') {
    const file = answerOf('change_file');
    return agent === FIXTURE.agent && url.searchParams.get('key') === file.key && url.searchParams.get('path') === file.path
      ? [200, file] : [404, { message: 'No such file in this patch' }];
  }
  const source = url.searchParams.get('source');
  if (source !== null && !SOURCES.includes(source)) return [400, { message: `source is ${SOURCES.join(' or ')}` }];
  if (agent !== FIXTURE.agent) {
    return [200, { ...answerOf('changes'), source: source ?? 'submitted', key: null, files: [], patches: [] }];
  }
  return [200, answerOf(source === 'checkpoint' ? 'changes_checkpoint' : 'changes')];
}

/** `GET …/<run>/agents/<agent>/<tab>…` for an agent of the sample run (`agents`: its ids). */
export function agentRoute(agent, rest, url, agents) {
  if (!agents.includes(agent) && agent !== FIXTURE.gate_agent) return [404, { message: 'No such agent in this run' }];
  const [tab, ...more] = rest;
  if (tab === 'thread') return thread(agent, more, url);
  if (tab === 'changes') return changes(agent, more, url);
  if (more.length > 0) return [404, { message: 'Engineering run not found' }];
  if (tab === 'files') return [200, agent === FIXTURE.agent ? answerOf('files') : { files: [], truncated: false }];
  if (tab === 'memory') return [200, agent === FIXTURE.agent ? answerOf('memory') : { recalled: [], learned: [] }];
  if (tab === 'gate') {
    return [200, agent === FIXTURE.gate_agent ? answerOf('gate')
      : { key: null, record: null, checks: [], passed: null, packs: [], ran_at: null }];
  }
  return [404, { message: 'Engineering run not found' }];
}

export function assertions() {
  return [200, answerOf('assertions')];
}

/** `POST …/steer`, as the server checks it; `say` records it in the mock's conversation. */
export function steer(body, agents, say, runId) {
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (Object.keys(body ?? {}).some((key) => !['text', 'about', 'thread_id'].includes(key))) {
    return [400, { message: 'the body is {text, about?, thread_id?}' }];
  }
  const summary = body.about ? `About ${body.about}: ${text}` : text;
  if (!text || Buffer.byteLength(summary) > MAX_STEER_BYTES) {
    return [400, { message: `text is what the orchestrator should do, at most ${MAX_STEER_BYTES} bytes with the agent it is about` }];
  }
  if (body.about !== undefined && !agents.includes(body.about)) return [404, { message: 'no such agent in this run' }];
  if (body.thread_id !== undefined && !ID.test(String(body.thread_id))) return [400, { message: 'thread_id is the id of the thread you steer on' }];
  const at = new Date().toISOString();
  const threadId = body.thread_id ?? `steer-${Date.now()}`;
  const eventId = say({ kind: 'human', id: 'mock-admin' }, { kind: 'conductor', id: runId }, 'msg.steer', summary, { threadId, at });
  return [202, { message: { event_id: eventId, thread_id: threadId, at } }];
}

/** `POST …/restart`: a child run of an ended run (409 while the run is live). */
export function restart(runId, body, live) {
  if (!['resume', 'restart'].includes(body?.mode)) return [400, { message: 'mode is resume or restart' }];
  if (body.base !== undefined && !['same', 'head'].includes(body.base)) return [400, { message: 'base is same or head' }];
  if (body.confirm !== true) return [400, { message: 'a restart starts a new run of this one: send confirm: true' }];
  if (live) {
    return [409, { message: 'The run is live: restart one of its agents with the restart signal (from its checkpoint or afresh), or stop the run first.' }];
  }
  return [202, { run: { ...answerOf('restart').run, parent_run_id: runId } }];
}
