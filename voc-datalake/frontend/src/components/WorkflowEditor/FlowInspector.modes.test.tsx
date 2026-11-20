/**
 * @fileoverview The inspector per kind past its first panel (7.52.00 C2; docs/ux part 5 §5.4), in each mode: a gate's
 * reviewers added and removed while building, its packs read only (Auto-detect's pack per automation, the owner's
 * brief, the tools last recorded, a read that failed), its assertions and arrows, and in a run its checks and its
 * reviewers; a call's inputs given their text and its child previewed; Start's settings written and read (memory,
 * Learn with its model, share and roles, the inputs the flow declares); an end's pull request and a decision waiting;
 * a platform step's setting, assertions and arrows, each arrow taken or not in a run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { workflowView } from '@test/workflowFixtures'
import { ApiError } from '../../lib/errors'
import { FLOW, GATES, changedStep, inspect, node, setUpInspector } from './flowInspector-fixtures'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { InspectorRun } from './inspector/inspectorParts'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
vi.mock('../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))

beforeEach(() => { setUpInspector() })

/** The bug hunt with step `id`'s settings replaced. */
function withParams(id: string, params: Record<string, unknown>, definition: WorkflowDefinition = FLOW): WorkflowDefinition {
  return { ...definition, nodes: definition.nodes.map((each) => (each.id === id ? { ...each, data: { ...each.data, params } } : each)) }
}

const runOf = (extra: Partial<InspectorRun> = {}): InspectorRun => ({ revision: 4, states: new Map(), ...extra })

/** Every fact shown, as `[term, value]`. */
const facts = () => [...document.querySelectorAll('dt')].map((term) => [term.textContent, term.nextElementSibling?.textContent])

describe('a gate', () => {
  it('adds a reviewer with what it looks for, and removes an advisory one', async () => {
    const onChange = inspect({ kind: 'step', id: 'gate' })
    const user = userEvent.setup()
    const add = within(screen.getByRole('group', { name: 'Add a reviewer' }))
    await user.type(add.getByLabelText('Reviewer\'s name'), 'Perf')
    await user.type(add.getByLabelText('What it looks for'), ' Latency regressions ')
    await user.click(add.getByRole('button', { name: 'Add a reviewer' }))
    const defaults = [{ name: 'security' }, { name: 'quality' }]
    expect(changedStep(onChange, 'gate')?.data.params?.reviewers).toStrictEqual([...defaults, { name: 'first-principles' }, { name: 'perf', focus: 'Latency regressions' }])
    await user.click(screen.getByRole('button', { name: 'Remove first-principles' }))
    expect(changedStep(onChange, 'gate')?.data.params?.reviewers).toStrictEqual(defaults)
  })

  it('reads its packs: Auto-detect\'s pack for each automation, the owner\'s brief and the tools last recorded', async () => {
    const [python] = GATES.packs
    setUpInspector({
      'GET /workflows/wf_1': () => workflowView(1, FLOW, { used_by: { flows: [], automations: [
        { agent_id: 'ag_1', name: 'Bug fixer', kind: 'engineering', language: 'python' }, { agent_id: 'ag_2', name: 'Docs bot', kind: 'engineering', language: 'go' },
      ] } }),
      'GET /agents/engineering/gates': () => ({
        ...GATES, packs: [{ ...python, briefs: ['brief_py'], recorded: { tool_versions: { ruff: '0.9.1' }, run_id: null, at: null } }],
        briefs: [{ id: 'brief_py', path: 'docs/gate-python.md', packs: ['python'], digest: '', bytes: 10 }],
      }),
    })
    inspect({ kind: 'step', id: 'gate' }, 'view', undefined, { definition: withParams('gate', { packs: 'auto' }), workflowId: 'wf_1' })
    await userEvent.click(screen.getByRole('tab', { name: 'Packs' }))
    expect(await screen.findByText('For Bug fixer: Python')).toBeInTheDocument()
    expect(screen.queryByText(/Docs bot/)).not.toBeInTheDocument()
    expect(screen.getByText('The owner\'s brief (docs/gate-python.md)')).toBeInTheDocument()
    expect(facts()).toContainEqual(['Tools', 'The repository\'s own pins. Last recorded: ruff 0.9.1'])
  })

  it('offers to read its packs again when the read failed', async () => {
    setUpInspector({ 'GET /agents/engineering/gates': () => { throw new ApiError(404, 'no gates here') } })
    inspect({ kind: 'step', id: 'gate' }, 'view')
    await userEvent.click(screen.getByRole('tab', { name: 'Packs' }))
    expect(await screen.findByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('lists its assertions and its arrows in words outside building', async () => {
    inspect({ kind: 'step', id: 'gate' }, 'view')
    const user = userEvent.setup()
    await user.click(screen.getByRole('tab', { name: 'Assertions' }))
    expect(screen.getByText('No assertions.')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Arrows' }))
    expect(screen.getByText('→ Pull request').closest('li')).toHaveTextContent('Pass')
  })

  it('shows a run\'s checks from the run workspace, and its reviewers, each blocking or advisory', async () => {
    const reviewers = [{ name: 'security' }, { name: 'perf', focus: 'Latency', advisory: true, model_id: 'global.anthropic.claude-haiku-5' }, 'not one']
    inspect({ kind: 'step', id: 'gate' }, 'run', runOf({ checksOf: () => <p>ruff check passed</p> }), {
      definition: withParams('gate', { packs: ['python'], reviewers }),
    })
    expect(screen.getByText('ruff check passed')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('tab', { name: 'Reviewers' }))
    expect(facts()).toStrictEqual([['security', 'blocks'], ['perf', 'advisory']])
  })

  it('says a run\'s gate has not run yet', () => {
    inspect({ kind: 'step', id: 'gate' }, 'run', runOf())
    expect(screen.getByText('The gate hasn\'t run yet.')).toBeInTheDocument()
  })
})

describe('a call', () => {
  it('gives an input of the flow it calls its text, keeping the others', async () => {
    const onChange = inspect({ kind: 'step', id: 'triage' }, 'build', undefined, {
      definition: withParams('triage', { flow: 'wf_17a9e5c3b2d0@2', inputs: { issue: 'Bug 12', stale: 7 } }),
    })
    await userEvent.type(await screen.findByLabelText('issue (required)'), '3')
    expect(changedStep(onChange, 'triage')?.data.params?.inputs).toStrictEqual({ issue: 'Bug 123' })
  })

  it('previews the flow it calls, read only', async () => {
    inspect({ kind: 'step', id: 'triage' }, 'view')
    await userEvent.click(screen.getByRole('tab', { name: 'Preview' }))
    expect(await screen.findByRole('application', { name: 'Issue triage, read only' })).toBeInTheDocument()
  })
})

describe('Start, an end and a decision', () => {
  it('writes Start\'s memory recall and Learn while building', async () => {
    const onChange = inspect({ kind: 'step', id: 'start' })
    const user = userEvent.setup()
    await user.click(screen.getByLabelText('Recall the repository\'s memory at the start'))
    expect(changedStep(onChange, 'start')?.data.params?.memory).toStrictEqual({ recall: true })
    await user.click(screen.getByLabelText('Learn from each run'))
    expect(changedStep(onChange, 'start')?.data.params?.learn).toStrictEqual({ enabled: false, after_needs_human_hours: 48 })
  })

  it('reads Start\'s settings outside building: Learn\'s model, share and roles, and the inputs the flow declares', () => {
    const learn = { enabled: true, model: 'global.anthropic.claude-sonnet-5-5', budget_share: 0.05, roles: ['fixer', 'hunter'] }
    const definition = { ...withParams('start', { memory: { recall: true }, learn }), inputs: { feedback: { type: 'text', max: 50 }, issue: { type: 'issue' } } }
    inspect({ kind: 'step', id: 'start' }, 'view', undefined, { definition })
    expect(facts()).toStrictEqual(expect.arrayContaining([
      ['Inputs', 'feedback, at most 50 · issue'], ['Memory', 'Recalled at the start'], ['Learn', 'On · Sonnet 5.5 · 5 % · 2 roles · after 72 h'],
    ]))
    expect(screen.getByText('Fixer, Bug hunter')).toBeInTheDocument()
  })

  it('says what a pull request step does, with the state Start gives it and the run\'s pull request', () => {
    inspect({ kind: 'step', id: 'pr' }, 'run', runOf({ pullRequest: { number: 7, url: 'https://github.com/example-org/shop/pull/7' } }))
    expect(facts()).toStrictEqual(expect.arrayContaining([['Pull request', 'A draft'], ['Pull request', 'PR #7']]))
    expect(screen.getByRole('link', { name: 'PR #7' })).toHaveAttribute('href', 'https://github.com/example-org/shop/pull/7')
  })

  it('says a decision a run waits at is waiting for you', () => {
    inspect({ kind: 'step', id: 'human' }, 'run', runOf({ states: new Map([['human', { status: 'waiting', rounds: 0 }]]) }))
    expect(screen.getByText('Waiting for you')).toBeInTheDocument()
  })
})

describe('a platform step', () => {
  const SHARDED: WorkflowDefinition = {
    ...FLOW,
    nodes: [...FLOW.nodes, node('shard', 'map', 'Shard the files', { shard_by: 'packages', shard_cap: 50 })],
    edges: [...FLOW.edges, { id: 'e5', source: 'shard', target: 'fix' }, { id: 'e6', source: 'shard', target: 'pr' }],
  }

  it('reads its setting, its assertions and its arrows, each taken or not in a run', () => {
    const states = new Map([['fix', { status: 'running' as const, rounds: 1 }], ['pr', { status: 'idle' as const, rounds: 0 }]])
    inspect({ kind: 'step', id: 'shard' }, 'run', runOf({ states }), { definition: SHARDED })
    expect(facts()).toContainEqual(['Setting', 'By Packages · at most 50'])
    expect(screen.getByText('→ Fix the bug').closest('li')).toHaveTextContent('Taken')
    expect(screen.getByText('→ Pull request').closest('li')).toHaveTextContent('Not taken')
  })

  it('says a step no arrow leaves yet has none', () => {
    inspect({ kind: 'step', id: 'shard' }, 'view', undefined, { definition: { ...SHARDED, edges: FLOW.edges } })
    expect(screen.getByText('No arrows leave this step yet.')).toBeInTheDocument()
  })
})
