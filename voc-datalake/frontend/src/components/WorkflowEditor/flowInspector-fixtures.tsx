/**
 * @fileoverview The inspector specs' flow, setup reads and mount (FlowInspector.test.tsx, FlowInspector.modes.test.tsx,
 * inspector/AssertionsField.test.tsx): a bug hunt that calls a triage flow, the Registry's fixer card, a Python gate
 * pack, the assertions' vocabulary, and the routes that answer them. A spec mocks `api/client`, `store/authStore`
 * and `runtimeConfig` itself (vi.mock is per file) and calls {@link setUpInspector} before each test.
 */
import { vi } from 'vitest'
import { TestRouter } from '@test/TestRouter'
import { renderWithQueryClient } from '@test/query-client'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { engineeringModule } from '@test/engineeringModule'
import { BUG_HUNT_EDGES } from '@test/workflowFixtures'
import { FlowInspector } from './FlowInspector'
import type { RouteHandler } from '@test/fetchApiRoutes'
import type { WorkflowDefinition } from '../../api/workflowsApi'
import type { FlowInspectorProps } from './FlowInspector'
import type { FlowSelection } from './FlowCanvas'
import type { InspectorRun } from './inspector/inspectorParts'

const CHILD = 'wf_17a9e5c3b2d0'

export const node = (id: string, type: WorkflowDefinition['nodes'][number]['type'], title: string, params: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data: { title, params } })

export const FLOW: WorkflowDefinition = {
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
export const GATES = {
  packs: [{ id: 'python', name: 'Python', languages: ['python'], image: { python: '3.12' }, network: ['pypi.org'], tools: [{ name: 'ruff' }],
    steps: [{ id: 'py.ruff', language: 'python', name: 'ruff check', kind: 'lint', argv: ['ruff'], when_any: [{ file: 'ruff.toml' }], looked_at_nothing: null, messages: [] }],
    briefs: [] }],
  aliases: {}, own_gate: { file: 'scripts/validate.sh' }, briefs: [], defaults: { runner: 'gate-runner@latest', final_go: 'final-go@latest' }, stops: [],
}
export const VOCABULARY = {
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

/** An administrator where the engineering agents are on, the setup reads answered (`extra` added or replacing). */
export function setUpInspector(extra: Record<string, RouteHandler> = {}): void {
  resetFetchApi()
  routeFetchApi({ ...ROUTES, ...extra })
  adminFlag.isAdmin = true
  engineeringModule.available = true
}

/** The inspector on `selection` in `mode` (`props` beside: another definition, the flow's id); its `onChange` spy. */
export function inspect(selection: FlowSelection, mode: 'build' | 'view' | 'run' = 'build', run?: InspectorRun,
  props: Partial<FlowInspectorProps> = {}) {
  const onChange = vi.fn<(definition: WorkflowDefinition) => void>()
  renderWithQueryClient(
    <TestRouter><FlowInspector definition={FLOW} mode={mode} selection={selection} onChange={onChange} run={run} {...props} /></TestRouter>,
  )
  return onChange
}

/** The step `id` of the last definition `onChange` was given. */
export function changedStep(onChange: ReturnType<typeof inspect>, id: string) {
  return onChange.mock.calls.at(-1)?.[0].nodes.find((each) => each.id === id)
}
