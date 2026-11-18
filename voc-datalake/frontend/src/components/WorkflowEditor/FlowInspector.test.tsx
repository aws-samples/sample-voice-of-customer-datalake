/**
 * @fileoverview The inspector per kind (7.52.00 C2; docs/ux part 5 §5.4): "In this flow" is edited only while building
 * (text otherwise, never disabled inputs), "From the card" is always read only, a gate shows its packs and edits its
 * reviewers, a call names the flow it calls and its inputs, Start's settings and a decision say what happens, an
 * arrow reads "Always" where its source reports no verdict, a step's assertions are edited from the vocabulary, and
 * a run's step shows its agents.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestRouter } from '@test/TestRouter'
import { renderWithQueryClient } from '@test/query-client'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { BUG_HUNT_EDGES } from '@test/workflowFixtures'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { FlowSelection } from './FlowCanvas'
import type { InspectorRun } from './inspector/inspectorParts'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
vi.mock('../../runtimeConfig', (importOriginal) =>
  import('@test/engineeringModule').then((m) => m.runtimeConfigModule(importOriginal)))
const { engineeringModule } = await import('@test/engineeringModule')
const { FlowInspector } = await import('./FlowInspector')

const CHILD = 'wf_17a9e5c3b2d0'
const node = (id: string, type: WorkflowDefinition['nodes'][number]['type'], title: string, params: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data: { title, params } })

const FLOW: WorkflowDefinition = {
  schema: 'voc-workflow/2',
  name: 'Bug hunt',
  nodes: [
    node('start', 'start', 'Start', { pr: 'draft', learn: { enabled: true, after_needs_human_hours: 48 } }),
    node('fix', 'agent', 'Fix the bug', { role: 'fixer', skill_version: 'latest', budget_share: 0.1 }),
    node('gate', 'quality_gate', 'Quality gate', { packs: ['python'], max_rounds: 3 }),
    node('triage', 'call_flow', 'Triage the issue', { flow: `${CHILD}@2` }),
    node('human', 'end', 'A person decides', { status: 'needs_human' }),
    node('pr', 'stop_at_pr', 'Pull request'),
  ],
  edges: [...BUG_HUNT_EDGES, { id: 'e4', source: 'gate', target: 'human', label: 'fail' }],
  loops: [],
}

const CARD = {
  kind: 'role', id: 'fixer', base_role: 'fixer', title: 'fixer', purpose: 'Smallest fix for one confirmed bug.',
  skill: { source: 'template', label: 'fixer@template-3', version: null, template_version: 3, template_newer: false },
  model: 'global.anthropic.claude-sonnet-5-5', tools: ['read_file', 'write_file'], harness: 'converse', broker_ops: ['read'],
  caps: { max_turns: 150 }, inputs: [{ name: 'bug' }], outputs: [{ name: 'patch' }], node: null,
}
const GATES = {
  packs: [{ id: 'python', name: 'Python', languages: ['python'], image: { python: '3.12' }, network: ['pypi.org'], tools: [{ name: 'ruff' }],
    steps: [{ id: 'py.ruff', language: 'python', name: 'ruff check', kind: 'lint', argv: ['ruff'], when_any: [{ file: 'ruff.toml' }], looked_at_nothing: null, messages: [] }],
    briefs: [] }],
  aliases: {}, own_gate: { file: 'scripts/validate.sh' }, briefs: [], defaults: { runner: 'gate-runner@latest', final_go: 'final-go@latest' }, stops: [],
}
const VOCABULARY = {
  checks: [{ check: 'patch.submitted', asks: 'a patch was submitted', label_key: '', description_key: '', args: [], kinds: ['agent', 'board'], on_fail: ['block', 'warn'] }],
  on_fail: [{ id: 'block', means: '' }], default_on_fail: 'block', max: 10, roles: ['fixer'],
}
const ROUTES: Record<string, RouteHandler> = {
  'GET /agents/engineering/registry/fixer': () => ({ card: CARD, versions: [], events: [] }),
  'GET /agents/engineering/registry': () => ({ connection: '', cards: [CARD] }),
  'GET /agents/engineering/gates': () => GATES,
  'GET /agents/engineering/assertions': () => VOCABULARY,
  'GET /workflows': () => ({ items: [{ workflow_id: CHILD, name: 'Issue triage', revision: 2, kind: 'engineering', status: 'active' }] }),
  [`GET /workflows/${CHILD}/revisions/2`]: () => ({
    workflow_id: CHILD, revision: 2, name: 'Issue triage', saved_at: null, saved_by_username: null,
    definition: { ...FLOW, name: 'Issue triage', inputs: { issue: { type: 'issue', required: true } } },
  }),
}

beforeEach(() => {
  resetFetchApi()
  routeFetchApi(ROUTES)
  adminFlag.isAdmin = true
  engineeringModule.available = true
})

function inspect(selection: FlowSelection, mode: 'build' | 'view' | 'run' = 'build', run?: InspectorRun) {
  const onChange = vi.fn<(definition: WorkflowDefinition) => void>()
  renderWithQueryClient(
    <TestRouter><FlowInspector definition={FLOW} mode={mode} selection={selection} onChange={onChange} run={run} /></TestRouter>,
  )
  return onChange
}

const inFlow = () => screen.getByRole('region', { name: 'In this flow' })

describe('an agent', () => {
  it('edits its own fields while building, and reads its card, read only', async () => {
    inspect({ kind: 'step', id: 'fix' })
    expect(within(inFlow()).getByLabelText('Title')).toHaveValue('Fix the bug')
    const card = screen.getByRole('region', { name: 'From the card' })
    expect(await within(card).findByText('Smallest fix for one confirmed bug.')).toBeInTheDocument()
    expect(within(card).queryAllByRole('textbox')).toStrictEqual([])
  })

  it('reads its own fields as text when viewed, saying it is read only', () => {
    inspect({ kind: 'step', id: 'fix' }, 'view')
    expect(screen.getByText('Read only.')).toBeInTheDocument()
    expect(within(inFlow()).queryAllByRole('textbox')).toStrictEqual([])
    expect(within(inFlow()).getByText('Fix the bug')).toBeInTheDocument()
  })

  it('adds an assertion from the vocabulary, with its default on_fail', async () => {
    const onChange = inspect({ kind: 'step', id: 'fix' })
    await userEvent.click(screen.getByRole('tab', { name: 'Assertions' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Add an assertion' }))
    const fix = onChange.mock.calls.at(-1)?.[0].nodes.find((each) => each.id === 'fix')
    expect(fix?.data.params?.assert).toStrictEqual([{ check: 'patch.submitted', on_fail: 'block' }])
  })

  it('shows a run\'s agents on the step, from the run workspace', () => {
    const run: InspectorRun = { revision: 4, states: new Map(), agentsOf: () => <p>fixer-1 is at work</p> }
    inspect({ kind: 'step', id: 'fix' }, 'run', run)
    expect(screen.getByText('As this run used it · r4')).toBeInTheDocument()
    expect(screen.getByText('fixer-1 is at work')).toBeInTheDocument()
  })
})

describe('a gate', () => {
  it('names who runs it and where GO and NO-GO go, and edits its reviewers', async () => {
    const onChange = inspect({ kind: 'step', id: 'gate' })
    expect(await screen.findByText('GO → Pull request · NO-GO → A person decides')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('first-principles: blocks or advisory'), 'blocks')
    const gate = onChange.mock.calls.at(-1)?.[0].nodes.find((each) => each.id === 'gate')
    expect(gate?.data.params?.reviewers).toStrictEqual([{ name: 'security' }, { name: 'quality' }, { name: 'first-principles', advisory: false }])
  })

  it('shows its packs read only: their steps in words and the repository\'s own pins', async () => {
    inspect({ kind: 'step', id: 'gate' })
    await userEvent.click(screen.getByRole('tab', { name: 'Packs' }))
    expect(await screen.findByText(': if ruff.toml is there')).toBeInTheDocument()
    expect(screen.getByText('The repository\'s own pins.')).toBeInTheDocument()
  })
})

describe('a call, a decision, the trigger and an arrow', () => {
  it('names the flow a call calls at its revision, and the inputs that flow declares', async () => {
    inspect({ kind: 'step', id: 'triage' })
    expect(await screen.findByLabelText('issue (required)')).toBeInTheDocument()
    expect(await screen.findByRole('option', { name: 'Issue triage' })).toBeInTheDocument()
  })

  it('says what a decision does, edits only its title, and Start\'s pull request state', () => {
    inspect({ kind: 'step', id: 'human' })
    expect(screen.getByText('Learn reads it after 48 h')).toBeInTheDocument()
    expect(within(inFlow()).getByLabelText('Title')).toHaveValue('A person decides')
  })

  it('edits Start\'s settings: the pull request opens as a draft', () => {
    inspect({ kind: 'step', id: 'start' })
    expect(screen.getByLabelText('Pull request')).toHaveValue('draft')
  })

  it('reads an arrow out of a step without a verdict as always taken, outside building', () => {
    inspect({ kind: 'edge', id: 'e2' }, 'view')
    expect(screen.getByText('Always: this step reports no verdict')).toBeInTheDocument()
  })
})
