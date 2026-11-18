/**
 * @fileoverview The run's canvas on the one flow canvas (7.52.00 C2; owner decision N-D3): a step selected (a click or
 * Enter) opens its Step view, a lane opens its agent's session, a call's `<call>.<child>` steps are framed under it
 * from the overview's `run.expansion` with how many are done, and an agent step's chips say what ran.
 *
 * jsdom cannot lay out React Flow, so `ReactFlow` is a probe that records the props the canvas passes it.
 */
import { describe, expect, it, vi } from 'vitest'
import { act } from '@testing-library/react'
import { renderWithQueryClient as render } from '@test/query-client'
import { engineeringOverview } from '@test/engineeringRunFixtures'
import { parseOverview } from '../../../api/engineeringRunsApi'
import { callGroups } from '../../../components/WorkflowEditor/callGroups'
import { ranOnSteps } from './runFlow'
import { probedFlowProps as props } from '@test/reactFlowProbe'
import type { Node } from '@xyflow/react'
import type { WorkflowDefinition } from '../../../api/workflowsApi'

vi.mock('@xyflow/react', async (importOriginal) =>
  (await import('@test/reactFlowProbe')).reactFlowProbeModule(importOriginal))

const { RunCanvas } = await import('./RunCanvas')

/** The first lane the canvas draws. */
function firstLane(): Node {
  const lane = props().nodes.find((node) => node.type === 'lane')
  if (lane === undefined) throw new Error('no lane drawn')
  return lane
}

/** A click on a node, as React Flow hands it to `onNodeClick` (its event is not read). */
function clickNode(node: Node): void {
  props().onNodeClick(new MouseEvent('click'), node)
}

const step = (id: string, type: WorkflowDefinition['nodes'][number]['type'], params: Record<string, unknown> = {}) =>
  ({ id, type, position: { x: 0, y: 0 }, data: { title: id, params } })

/** start → board → gate → end, and a call of Issue triage expanded as `triage.classify` and `triage.label`. */
const FLOW: WorkflowDefinition = {
  schema: 'voc-workflow/2',
  name: 'Bug hunt',
  nodes: [step('start', 'start'), step('triage.classify', 'agent', { role: 'understander' }), step('triage.label', 'agent', { role: 'understander' }),
    step('board', 'board', { posters: ['hunter'], claimers: ['fixer'] }), step('gate', 'quality_gate'), step('end', 'end', { status: 'completed' })],
  edges: [
    { id: 'a', source: 'start', target: 'triage.classify' }, { id: 'b', source: 'triage.classify', target: 'triage.label' },
    { id: 'c', source: 'triage.label', target: 'board' }, { id: 'd', source: 'board', target: 'gate' },
    { id: 'e', source: 'gate', target: 'end', label: 'pass' },
  ],
  loops: [],
}

const overview = () => parseOverview(engineeringOverview({
  flow_steps: { start: 'done', 'triage.classify': 'done', 'triage.label': 'running', board: 'not_yet_run' },
  expansion: [{ step: 'triage', flow: 'wf_17a9e5c3b2d0', revision: 2 }],
}))

function renderCanvas() {
  const onOpen = vi.fn<(agent: string) => void>()
  const onSelectStep = vi.fn<(step: string | null) => void>()
  render(<RunCanvas overview={overview()} definition={FLOW} current={null} onOpen={onOpen} onSelectStep={onSelectStep} />)
  return { onOpen, onSelectStep }
}

describe('the run canvas (N-D3)', () => {
  it('opens a step\'s Step view when it is selected, from a click or Enter alike', () => {
    const { onSelectStep, onOpen } = renderCanvas()
    const gate = props().nodes.filter((node) => node.id === 'gate')
    act(() => props().onSelectionChange({ nodes: gate, edges: [] }))
    expect(onSelectStep).toHaveBeenLastCalledWith('gate')
    expect(onOpen).not.toHaveBeenCalled()
  })

  it('opens a lane\'s agent session, never a Step view', () => {
    const { onSelectStep, onOpen } = renderCanvas()
    act(() => clickNode(firstLane()))
    expect(onOpen).toHaveBeenCalledWith('fixer-1')
    expect(onSelectStep).not.toHaveBeenCalled()
  })

  it('frames the call\'s steps under it, with how many of them are done', () => {
    renderCanvas()
    const frames = props().nodes.filter((node) => node.type === 'callFrame').map((node) => node.ariaLabel)
    expect(frames).toStrictEqual(['wf_17a9e5c3b2d0 · r2, 1 of 2 steps done'])
  })
})

describe('callGroups', () => {
  it('finds each call\'s steps in the flat copy and how many are done', () => {
    const states = new Map([['triage.classify', { status: 'done' as const, rounds: 1 }]])
    const groups = callGroups(FLOW, [{ step: 'triage', flow: 'wf_17a9e5c3b2d0', revision: 2 }, { step: 'gone', flow: 'wf_x', revision: 1 }], states)
    expect(groups).toStrictEqual([{ call: 'triage', flow: 'wf_17a9e5c3b2d0', revision: 2, nodeIds: ['triage.classify', 'triage.label'], done: 1, total: 2 }])
  })

  it('says what ran on a step: its model, its skill\'s label, what it cost and how many agents', () => {
    const ran = ranOnSteps(parseOverview({
      ...engineeringOverview(),
      agents: [{ agent: 'fixer-1', role: 'fixer', model: 'global.anthropic.claude-sonnet-5-5', skill_label: 'fixer@template-3', cost_usd: 0.42 }],
    }))
    expect(ran.get('board')).toStrictEqual({ agents: 1, model: 'global.anthropic.claude-sonnet-5-5', skill: 'fixer@template-3', costUsd: 0.42 })
  })
})
