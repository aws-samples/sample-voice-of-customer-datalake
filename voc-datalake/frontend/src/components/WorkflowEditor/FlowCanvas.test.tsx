/**
 * @fileoverview The one flow canvas (7.52.00 C2): its nodes by KIND in flow order with their accessible names, a gate's
 * GO and NO-GO handles setting the arrow's verdict (owner decision N-D4) and drawing a stored verdict from its own
 * handle, nothing moving or connecting outside build, a run's call framed under it, and opening following the
 * selection (Enter as a click, Escape closing).
 *
 * jsdom cannot lay out React Flow, so `ReactFlow` is a probe that records the props the canvas passes it.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen } from '@testing-library/react'
import { renderWithQueryClient as render } from '@test/query-client'
import { probedFlowProps as props } from '@test/reactFlowProbe'
import { BUG_HUNT_EDGES } from '@test/workflowFixtures'
import { BLOCK_MIME, PALETTE_MIME } from './model'
import { drawnPosition } from './nodes/nodeKinds'
import type { WorkflowDefinition } from '../../api/workflowsApi'

vi.mock('@xyflow/react', async (importOriginal) =>
  (await import('@test/reactFlowProbe')).reactFlowProbeModule(importOriginal))

const { FlowCanvas } = await import('./FlowCanvas')

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
  edges: BUG_HUNT_EDGES,
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

describe('building on the canvas', () => {
  /** What a drag carries, by its types. */
  const carrying = (data: Record<string, string>) => ({ types: Object.keys(data), getData: (type: string) => data[type] ?? '', dropEffect: 'none' })
  const canvasOf = (container: HTMLElement) => container.querySelector('.voc-workflow') ?? document.body

  it('says what a palette item will add while over it, and adds the step dropped (a block, or a bare type)', () => {
    const onChange = vi.fn<(definition: WorkflowDefinition) => void>()
    const { container } = render(<FlowCanvas definition={FLOW} mode="build" onChange={onChange} />)
    fireEvent.dragOver(canvasOf(container), { dataTransfer: carrying({ [BLOCK_MIME]: '{}' }) })
    expect(screen.getByRole('status')).toHaveTextContent('Drop to add the step')
    fireEvent.drop(canvasOf(container), { dataTransfer: carrying({ [BLOCK_MIME]: '{"type":"agent","title":"Review the fix","params":{"role":"pr-reviewer"}}' }) })
    fireEvent.drop(canvasOf(container), { dataTransfer: carrying({ [PALETTE_MIME]: 'quality_gate' }) })
    expect(onChange.mock.calls.map(([next]) => next.nodes.at(-1)?.data)).toStrictEqual([
      { title: 'Review the fix', params: { role: 'pr-reviewer', skill_version: 'latest' } }, expect.objectContaining({ title: 'Quality gate' }),
    ])
  })

  it('takes nothing dropped outside build, nor what is not a step', () => {
    const onChange = vi.fn<(definition: WorkflowDefinition) => void>()
    const { container, rerender } = render(<FlowCanvas definition={FLOW} mode="build" onChange={onChange} />)
    fireEvent.drop(canvasOf(container), { dataTransfer: carrying({ [PALETTE_MIME]: 'no_such_step' }) })
    rerender(<FlowCanvas definition={FLOW} mode="view" onChange={onChange} />)
    fireEvent.dragOver(canvasOf(container), { dataTransfer: carrying({ [PALETTE_MIME]: 'agent' }) })
    fireEvent.drop(canvasOf(container), { dataTransfer: carrying({ [PALETTE_MIME]: 'agent' }) })
    expect([onChange.mock.calls, screen.queryByRole('status')]).toStrictEqual([[], null])
  })

  it('stores a step where it was let go (its column\'s corner), not while dragged, and drops a step deleted', () => {
    const onChange = vi.fn<(definition: WorkflowDefinition) => void>()
    render(<FlowCanvas definition={FLOW} mode="build" onChange={onChange} />)
    const letGo = drawnPosition(node('fix', 'agent', 160, { role: 'fixer' }))
    act(() => props().onNodesChange([
      { type: 'position', id: 'fix', dragging: true, position: { x: 10, y: 10 } },
      { type: 'position', id: 'fix', dragging: false, position: letGo }, { type: 'remove', id: 'human' },
    ]))
    const next = onChange.mock.calls.at(-1)?.[0]
    expect(next?.nodes.map((each) => each.id)).toStrictEqual(['pr', 'gate', 'fix', 'start'])
    expect(next?.nodes.find((each) => each.id === 'fix')?.position).toStrictEqual({ x: 0, y: 160 })
  })
})
