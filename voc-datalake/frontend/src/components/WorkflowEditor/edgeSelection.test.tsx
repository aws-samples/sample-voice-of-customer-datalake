/**
 * @fileoverview Arrow selection on the editable canvas (E2E s2 F1): the canvas
 * derives its edges from the definition (controlled), so React Flow's `select`
 * changes must be kept by the canvas — before the fix a clicked arrow never
 * became selected, so "Delete arrow", the condition picker and Delete/Backspace
 * were unreachable in production.
 *
 * jsdom cannot lay out React Flow edges (no handle bounds), so `ReactFlow` is
 * replaced by a probe that records the props the canvas passes and lets the
 * test send the edge changes React Flow would send on a click / Delete.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, render } from '@testing-library/react'
import { applyEdgeSelection, NO_EDGES } from './edgeSelection'
import { WORKFLOW_SCHEMA } from '../../api/workflowsApi'
import type { Edge, EdgeChange, OnSelectionChangeParams } from '@xyflow/react'
import type { CanvasSelection } from './selection'
import type { WorkflowDefinition } from '../../api/workflowsApi'

interface ProbeProps {
  edges: Edge[]
  onEdgesChange: (changes: EdgeChange[]) => void
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

const { WorkflowCanvas } = await import('./WorkflowCanvas')

function lastProps(): ProbeProps {
  if (probe.last === null) throw new Error('ReactFlow was not rendered')
  return probe.last
}

const edgeById = (id: string): Edge | undefined => lastProps().edges.find((e) => e.id === id)

describe('applyEdgeSelection', () => {
  it('adds a selected arrow and drops a deselected or removed one', () => {
    const one = applyEdgeSelection(NO_EDGES, [{ type: 'select', id: 'e1', selected: true }])
    expect([...one]).toStrictEqual(['e1'])
    const two = applyEdgeSelection(one, [{ type: 'select', id: 'e2', selected: true }])
    expect([...two].sort((a, b) => a.localeCompare(b))).toStrictEqual(['e1', 'e2'])
    expect([...applyEdgeSelection(two, [{ type: 'select', id: 'e1', selected: false }])]).toStrictEqual(['e2'])
    expect([...applyEdgeSelection(two, [{ type: 'remove', id: 'e2' }])]).toStrictEqual(['e1'])
  })

  it('keeps the same set when nothing changes (stable React state)', () => {
    const one = applyEdgeSelection(NO_EDGES, [{ type: 'select', id: 'e1', selected: true }])
    expect(applyEdgeSelection(one, [{ type: 'select', id: 'e1', selected: true }])).toBe(one)
    expect(applyEdgeSelection(one, [{ type: 'remove', id: 'zz' }])).toBe(one)
    expect(applyEdgeSelection(NO_EDGES, [])).toBe(NO_EDGES)
  })
})

const DEFINITION: WorkflowDefinition = {
  schema: WORKFLOW_SCHEMA,
  name: 'Two steps',
  nodes: [
    { id: 'start', type: 'start', position: { x: 0, y: 0 }, data: { title: 'Start' } },
    { id: 'end', type: 'end', position: { x: 0, y: 200 }, data: { title: 'Done', params: { status: 'completed' } } },
  ],
  edges: [{ id: 'e1', source: 'start', target: 'end' }],
  loops: [],
}

describe('WorkflowCanvas — arrow selection', () => {
  it('keeps a clicked arrow selected so React Flow reports and deletes it', () => {
    const onChange = vi.fn()
    render(<WorkflowCanvas definition={DEFINITION} onChange={onChange} />)
    expect(edgeById('e1')?.selected).toBe(false)
    act(() => lastProps().onEdgesChange([{ type: 'select', id: 'e1', selected: true }]))
    // The controlled edge now carries `selected`, which is what React Flow's selection
    // handler, the side panel (via onSelectionChange) and the Delete key all read.
    expect(edgeById('e1')?.selected).toBe(true)
    expect(onChange).not.toHaveBeenCalled()
    act(() => lastProps().onEdgesChange([{ type: 'select', id: 'e1', selected: false }]))
    expect(edgeById('e1')?.selected).toBe(false)
  })

  it('applies a Delete of the selected arrow to the definition', () => {
    const onChange = vi.fn()
    render(<WorkflowCanvas definition={DEFINITION} onChange={onChange} />)
    act(() => lastProps().onEdgesChange([{ type: 'select', id: 'e1', selected: true }]))
    act(() => lastProps().onEdgesChange([{ type: 'remove', id: 'e1' }]))
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ edges: [] }))
  })

  it('passes the selected arrow on to onSelectionChange', () => {
    const selections: CanvasSelection[] = []
    render(<WorkflowCanvas definition={DEFINITION} onSelectionChange={(s) => selections.push(s)} />)
    const edge = lastProps().edges.filter((e) => e.id === 'e1')
    expect(edge).toHaveLength(1)
    act(() => lastProps().onSelectionChange({ nodes: [], edges: edge }))
    expect(selections.at(-1)).toStrictEqual({ nodeIds: [], edgeIds: ['e1'], loopIndexes: [] })
  })

  it('never selects an arrow on the read-only run graph', () => {
    render(<WorkflowCanvas definition={DEFINITION} readOnly />)
    act(() => lastProps().onEdgesChange([{ type: 'select', id: 'e1', selected: true }]))
    expect(edgeById('e1')?.selected).toBe(false)
  })
})
