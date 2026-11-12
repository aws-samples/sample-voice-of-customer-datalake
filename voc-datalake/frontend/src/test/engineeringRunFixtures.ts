/**
 * @fileoverview A sample engineering run as the Agents API answers it (overview, board, a message, its flow), for the
 * run monitor's specs. Fictional data.
 */
import { workflowView } from './workflowFixtures'
import type { ConversationMessage } from '../api/engineeringRunsApi'

const TOKENS = [{ model: 'model-a', input_tokens: 1000, output_tokens: 200 }]

function agent(id: string, role: string, fields: Record<string, unknown> = {}) {
  return {
    agent: id, role, task_id: null, status: 'working', continuation: 0, started_at: 1_794_470_400, step: null,
    microvm_state: 'running', microvm_age: 1500, heartbeat_age: 30, last_progress_at: null, stuck_why: null,
    recent_tools: [], microvm_seconds: 300, tokens: TOKENS, ...fields,
  }
}

/**
 * The run's overview: the coordinator waiting on the board step, the fixer working on its task (on the board step),
 * and the final-go agent, whose step is the harness's own words (no node of the flow) and whose task is done.
 */
export function engineeringOverview(run: Record<string, unknown> = {}) {
  return {
    run: {
      run_id: 'RUN1', goal: 'Fix the paging bugs', repo: 'example-org/storefront', flow: 'wf_flow', status: 'running',
      started_at: '2026-11-12T08:00:00Z', ended_at: null, ...run,
    },
    agents: [
      agent('coordinator-0', 'coordinator', { status: 'waiting', step: 'board' }),
      agent('fixer-1', 'fixer', { step: 'board', task_id: 'task-1', continuation: 1, recent_tools: ['read_file', 'run_tests'] }),
      agent('final-go-1', 'final-go', {
        task_id: 'task-3', step: 'Reading the review rounds', stuck_why: 'No progress for 10 minutes', tokens: [],
      }),
    ],
    totals: {
      messages: 3, microvm_seconds: 900,
      by_model: [{ model: 'model-a', input_tokens: 2000, output_tokens: 400 }],
    },
  }
}

/** The board: the fixer's task (claimed at attempt 2), an open one, and the final-go agent's, done (lease kept). */
export function engineeringBoard() {
  const move = (state: string, by: string, attempt: number) => ({ state, at: '2026-11-12T08:10:00Z', by, op: 'claim', attempt, result_keys: 0 })
  return {
    tasks: [
      {
        task_id: 'task-1', role: 'fixer', state: 'in_progress', title: 'The last page shows one item too many', spec: {},
        depth: 1, priority: 1, attempt: 2, parent_task: null, lease: { agent: 'fixer-1', epoch: 2, expires: 0 },
        result_keys: [], posted_by: 'coordinator-0', updated_by: 'fixer-1', updated_at: '2026-11-12T08:20:00Z',
        spec_hash: 'a', history: [move('open', 'coordinator-0', 0), move('claimed', 'fixer-1', 2)],
      },
      {
        task_id: 'task-2', role: 'fixer', state: 'open', title: 'Sorting ignores the time zone', spec: {}, depth: 1,
        priority: 2, attempt: 0, parent_task: null, lease: null, result_keys: [], posted_by: 'coordinator-0',
        updated_by: 'coordinator-0', updated_at: '2026-11-12T08:10:00Z', spec_hash: 'b', history: [],
      },
      {
        task_id: 'task-3', role: 'final-go', state: 'done', title: 'The gate record for the page fix', spec: {}, depth: 1,
        priority: 1, attempt: 1, parent_task: null, lease: { agent: 'final-go-1', epoch: 1, expires: 0 }, result_keys: ['k'],
        posted_by: 'coordinator-0', updated_by: 'final-go-1', updated_at: '2026-11-12T08:50:00Z', spec_hash: 'c', history: [],
      },
    ],
  }
}

/** One message of the conversation, from the fixer to the conductor on thread t-7. */
export function engineeringMessage(seq: number, summary = `Message ${String(seq)}`): ConversationMessage {
  return {
    seq, type: 'msg.question', at: '2026-11-12T08:40:00Z',
    message: { from: { kind: 'agent', id: 'fixer-1' }, to: { kind: 'conductor', id: 'RUN1' }, summary, thread_id: 't-7' },
  }
}

/** The run's flow: start → board → gate → PR | a person. */
export function engineeringFlowView() {
  const node = (id: string, type: string, title: string, y: number, params: Record<string, unknown> = {}) =>
    ({ id, type, position: { x: 0, y }, data: { title, params } })
  return workflowView(1, {
    schema: 'voc-workflow/2', name: 'Fix the reported bugs', loops: [],
    nodes: [node('start', 'start', 'Start', 0), node('board', 'board', 'Fix board', 100), node('gate', 'quality_gate', 'Gate', 200),
      node('pr', 'stop_at_pr', 'Open the PR', 300), node('human', 'end', 'A person decides', 300, { status: 'needs_human' })],
    edges: [{ id: 'e1', source: 'start', target: 'board' }, { id: 'e2', source: 'board', target: 'gate' },
      { id: 'e3', source: 'gate', target: 'pr', label: 'pass' }, { id: 'e4', source: 'gate', target: 'human', label: 'fail' }],
  }, { workflow_id: 'wf_flow' })
}
