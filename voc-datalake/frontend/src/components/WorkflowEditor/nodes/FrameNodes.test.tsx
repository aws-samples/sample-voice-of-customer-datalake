/**
 * What the canvas draws outside React Flow's layout (7.52.00 C2): a "Calls a flow" step as its kind's renderer draws it
 * (the drag preview's way: the child flow by its name and pinned revision, its share, the same in its description;
 * "No flow chosen yet" before one is), the frame a run draws around a call's steps (its flow and progress), and a
 * run's lane, its state's icon named by the state and its attempt after the first.
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FlowLookupsContext } from './nodeData'
import { NodePreview } from './NodePreview'
import { CallFrameNode, LaneNode } from './FrameNodes'
import type { NodeProps } from '@xyflow/react'
import type { CallFrameFlowNode, FlowLookups, LaneFlowNode } from './nodeData'
import type { LaneState } from '../runState'

const CHILD = 'wf_17a9e5c3b2d0'
const LOOKUPS: FlowLookups = {
  mode: 'view', cards: new Map(), flows: new Map([[CHILD, { name: 'Issue triage', revision: 3 }]]), descPrefix: 'flow', prState: null, handles: false,
}

/** A node's props as React Flow hands them, for `data` of `type`. */
function propsOf<D extends Record<string, unknown>, T extends string>(id: string, type: T, data: D) {
  return {
    id, type, data, selected: false, dragging: false, zIndex: 0, selectable: false, deletable: false, draggable: false,
    isConnectable: false, positionAbsoluteX: 0, positionAbsoluteY: 0,
  }
}

const callStep = (params: Record<string, unknown>) => ({ id: 'triage', type: 'call_flow' as const, position: { x: 0, y: 0 }, data: { title: 'Triage the issue', params } })

describe('a "Calls a flow" step', () => {
  it('names the flow it calls at the revision it pins, and its share, in its description too', () => {
    render(<FlowLookupsContext.Provider value={LOOKUPS}><NodePreview step={callStep({ flow: `${CHILD}@2`, budget_share: 0.25 })} /></FlowLookupsContext.Provider>)
    expect(screen.getByTestId('step-triage')).toHaveAttribute('data-kind', 'call')
    expect(screen.getByText('Issue triage · r2')).toBeInTheDocument()
    expect(screen.getByText('Calls a flow, Issue triage · r2, 25 %')).toHaveClass('sr-only')
  })

  it('says when no flow is chosen yet', () => {
    render(<NodePreview step={callStep({})} />)
    expect(screen.getByText('No flow chosen yet')).toBeInTheDocument()
  })
})

describe('a run\'s frames and lanes', () => {
  it('frames a call\'s steps with its flow and how far they are', () => {
    const frame: NodeProps<CallFrameFlowNode> = propsOf('frame', 'callFrame', { call: 'triage', label: 'Issue triage · r2', progress: '1 of 3 steps done', width: 300, height: 200 })
    render(<CallFrameNode {...frame} />)
    expect(screen.getByTestId('call-frame-triage')).toHaveTextContent('Issue triage · r2· 1 of 3 steps done')
  })

  it.each([
    ['ran_failed', 'Failed'], ['waiting', 'Needs a person'], ['paused', 'Paused'], ['stopped', 'Stopped'], ['planned', 'Planned'],
  ] satisfies ReadonlyArray<readonly [LaneState, string]>)('draws a %s lane with its state\'s icon, named "%s"', (state, name) => {
    const lane: NodeProps<LaneFlowNode> = propsOf('lane', 'lane', {
      step: 'fix', label: 'fixer-3', role: 'fixer', state, attempt: 2, open: false, width: 160, height: 40,
    })
    render(<LaneNode {...lane} />)
    expect(screen.getByLabelText(name)).toBeInTheDocument()
    expect(screen.getByTestId('run-lane')).toHaveTextContent('fixer-3fixer · attempt 2')
  })
})
