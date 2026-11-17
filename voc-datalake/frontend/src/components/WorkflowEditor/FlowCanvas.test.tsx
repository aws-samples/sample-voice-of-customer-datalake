/**
 * @fileoverview The one flow canvas (7.52.00 C2): its nodes by KIND in flow order with their accessible names, a gate's
 * GO and NO-GO handles setting the arrow's verdict (owner decision N-D4) and drawing a stored verdict from its own
 * handle, nothing moving or connecting outside build, a run's call framed under it, and opening following the
 * selection (Enter as a click, Escape closing).
 *
 * jsdom cannot lay out React Flow, so `ReactFlow` is a probe that records the props the canvas passes it.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent } from '@testing-library/react'
import { renderWithQueryClient as render } from '@test/query-client'
import type { Connection, Edge, Node, OnSelectionChangeParams } from '@xyflow/react'
import type { WorkflowDefinition } from '../../api/workflowsApi'

interface ProbeProps {
  nodes: Node[]
  edges: Edge[]
  nodesDraggable: boolean
  nodesConnectable: boolean
  deleteKeyCode: unknown
  onConnect: (connection: Connection) => void
  onSelectionChange: (params: OnSelectionChangeParams) => void
}
const probe: { last: ProbeProps | null } = { last: null }

vi.mock('@xyflow/react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xyflow/react')>()
  function ReactFlowProbe(props: ProbeProps) {
    probe.last = props
    return null
  }
  return { ...actual, ReactFlow: ReactFlowProbe }
})

const { FlowCanvas } = await import('./FlowCanvas')

function props(): ProbeProps {
  if (probe.last === null) throw new Error('ReactFlow was not rendered')
  return probe.last
}

const node = (id: string, type: WorkflowDefinition['nodes'][number]['type'], y: number, params: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y }, data: { title: id === 'gate' ? 'Quality gate' : id, params } })

/** start → fix → gate (GO → pr, NO-GO → human), an engineering flow. */
const FLOW: WorkflowDefinition = {
  schema: 'voc-workflow/2',
  name: 'Bug hunt',
  nodes: [
    node('human', 'end', 400, { status: 'needs_human' }),
    node('pr', 'stop_at_pr', 400),
    node('gate', 'quality_gate', 260, { packs: 'auto' }),
    node('fix', 'agent', 130, { role: 'fixer' }),
    node('start', 'start', 0),
  ],
  edges: [
    { id: 'e1', source: 'start', target: 'fix' },
    { id: 'e2', source: 'fix', target: 'gate' },
    { id: 'e3', source: 'gate', target: 'pr', label: 'pass' },
  ],
  loops: [],
}

describe('the nodes', () => {
  it('draws each step by its kind, in flow order (a step the start never reaches last), named "<kind>: <title>"', () => {
    render(<FlowCanvas definition={FLOW} mode="view" />)
    const steps = props().nodes.map((each) => [each.id, each.type])
    expect(steps).toStrictEqual([['start', 'trigger'], ['fix', 'agent'], ['gate', 'gate'], ['pr', 'end'], ['human', 'decision']])
    expect(props().nodes.find((each) => each.id === 'gate')?.ariaLabel).toBe('Gate: Quality gate')
  })

  it('moves, connects and deletes nothing outside build', () => {
    render(<FlowCanvas definition={FLOW} mode="run" runState={{ steps: new Map([['fix', { status: 'running', rounds: 1 }]]) }} />)
    expect([props().nodesDraggable, props().nodesConnectable, props().deleteKeyCode]).toStrictEqual([false, false, null])
    expect(props().nodes.find((each) => each.id === 'fix')?.ariaLabel).toBe('Agent: fix, running')
  })
})

describe('a gate\'s verdict handles (N-D4)', () => {
  it('draws a stored GO arrow from the GO handle, and a plain arrow from the plain one', () => {
    render(<FlowCanvas definition={FLOW} mode="build" />)
    expect(props().edges.map((edge) => [edge.id, edge.sourceHandle])).toStrictEqual([['e1', undefined], ['e2', undefined], ['e3', 'pass']])
  })

  it('sets the arrow\'s verdict by the handle it is dragged from', () => {
    const onChange = vi.fn<(definition: WorkflowDefinition) => void>()
    render(<FlowCanvas definition={FLOW} mode="build" onChange={onChange} />)
    act(() => props().onConnect({ source: 'gate', target: 'human', sourceHandle: 'fail', targetHandle: null }))
    expect(onChange.mock.calls.at(-1)?.[0].edges.find((edge) => edge.target === 'human')?.label).toBe('fail')
  })
})

describe('a run\'s calls', () => {
  it('frames a call\'s <call>.<child> steps under it', () => {
    const run: WorkflowDefinition = { ...FLOW, nodes: [...FLOW.nodes, node('triage.classify', 'agent', 600, { role: 'understander' })] }
    const calls = [{ call: 'triage', label: 'Issue triage · r2', progress: '0 of 1 steps done', nodeIds: ['triage.classify'] }]
    render(<FlowCanvas definition={run} mode="run" runState={{ steps: new Map(), calls }} />)
    expect(props().nodes.filter((each) => each.type === 'callFrame').map((each) => each.ariaLabel)).toStrictEqual(['Issue triage · r2, 0 of 1 steps done'])
  })
})

describe('opening follows the selection', () => {
  it('opens a step selected from the keyboard as one from the keyboard, and Escape closes it', () => {
    const onSelect = vi.fn()
    const { container } = render(<FlowCanvas definition={FLOW} mode="view" onSelect={onSelect} />)
    const canvas = container.querySelector('.voc-workflow') ?? document.body
    fireEvent.keyDown(canvas, { key: 'Enter' })
    const gate = props().nodes.filter((each) => each.id === 'gate')
    act(() => props().onSelectionChange({ nodes: gate, edges: [] }))
    expect(onSelect).toHaveBeenLastCalledWith({ kind: 'step', id: 'gate' }, { keyboard: true })
    fireEvent.keyDown(canvas, { key: 'Escape' })
    expect(onSelect).toHaveBeenLastCalledWith(null)
  })
})
