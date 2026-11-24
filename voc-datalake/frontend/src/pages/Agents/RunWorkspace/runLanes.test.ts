/**
 * @fileoverview The run canvas's model against the shared fixture: each step a stage in rows from the start, a step's
 * agents as sibling lanes under it that never overlap, a lane's state (and its dashed border while planned), the
 * bounded label, a gate's verdict, and the timeline of steps, agents and attempts (7.51.04: the orchestrator its own).
 */
import { describe, expect, it } from 'vitest'
import fixture from '@test/engineeringRunWorkspace.json'
import { parseOverview } from '../../../api/engineeringRunsApi'
import { laneBorder } from '../../../components/WorkflowEditor/runState'
import { STEP_WIDTH } from '../../../components/WorkflowEditor/model'
import { drawnPosition, nodeSize } from '../../../components/WorkflowEditor/nodes/nodeKinds'
import { LANES_PER_LINE, LANE_HEIGHT, LANE_OFFSET, LANE_WIDTH, gateOutcome, laneLabel, laneState, layoutRun } from './runLanes'
import { buildTimeline } from './runTimelineModel'
import { runStepStates } from './runFlow'
import type { WorkflowDefinition, WorkflowNode } from '../../../api/workflowsApi'
import type { RunLane } from '../../../api/engineeringRunsApi'

const overview = parseOverview(fixture.overview.answer)
const definition: WorkflowDefinition | null = overview.run.flow_definition
const flow = definition ?? { nodes: [], edges: [], loops: [], name: '', schema: 'voc-workflow/2' }

interface Box { x: number; y: number; width: number; height: number }

const overlaps = (a: Box, b: Box): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height

/** Whether the straight segment from `a` to `b` passes through `box` (sampled every 2 px along it). */
function crossesBox(a: { x: number; y: number }, b: { x: number; y: number }, box: Box): boolean {
  const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 2))
  return Array.from({ length: steps + 1 }, (_, i) => i / steps).some((t) => {
    const x = a.x + (b.x - a.x) * t
    const y = a.y + (b.y - a.y) * t
    return x > box.x && x < box.x + box.width && y > box.y && y < box.y + box.height
  })
}

/** A card as the run draws it at the least: its shape centred in its column, its kind's height and a run's growth. */
function cardBox(node: WorkflowNode): Box {
  const size = nodeSize(node)
  return { ...drawnPosition(node), width: size.width, height: size.height + 32 }
}

describe('layoutRun', () => {
  const { definition: placed, lanes } = layoutRun(flow, overview.lanes, 'active')
  const y = (id: string) => placed.nodes.find((node) => node.id === id)?.position.y ?? -1
  const x = (id: string) => placed.nodes.find((node) => node.id === id)?.position.x ?? -1

  it('stacks the stages from the start along the flow, the gate\'s two ways side by side', () => {
    expect([y('start') < y('board'), y('board') < y('gate'), y('gate') < y('pr')]).toStrictEqual([true, true, true])
    expect(y('pr')).toBe(y('human'))
  })

  it('places each step\'s agents as lanes BESIDE it, siblings side by side that never overlap (7.54.00)', () => {
    const gate = lanes.filter((lane) => lane.step === 'gate')
    expect(lanes.map((lane) => [lane.step, lane.agent])).toStrictEqual([['board', 'fixer-3'], ['gate', 'gate-runner-4'], ['gate', 'final-go-5']])
    expect((gate[1]?.position.x ?? 0) - (gate[0]?.position.x ?? 0)).toBeGreaterThanOrEqual(LANE_WIDTH)
    expect(gate.every((lane) => lane.position.y >= y('gate') && lane.position.y < y('pr'))).toBe(true)
    expect(gate.every((lane) => lane.position.x >= x('gate') + STEP_WIDTH + LANE_OFFSET)).toBe(true)
  })

  it('never puts a lane on a card, nor on the straight way an arrow takes between two cards (7.54.00)', () => {
    const cards = placed.nodes.map((node) => ({ id: node.id, ...cardBox(node) }))
    const boxes = lanes.map((lane) => ({ x: lane.position.x, y: lane.position.y, width: LANE_WIDTH, height: LANE_HEIGHT }))
    expect(boxes.filter((box) => cards.some((card) => overlaps(box, card)))).toStrictEqual([])
    const crossed = placed.edges.filter((edge) => {
      const from = cards.find((card) => card.id === edge.source)
      const to = cards.find((card) => card.id === edge.target)
      return from !== undefined && to !== undefined && boxes.some((box) => crossesBox(
        { x: from.x + from.width / 2, y: from.y + from.height }, { x: to.x + to.width / 2, y: to.y }, box))
    })
    expect(crossed).toStrictEqual([])
  })

  it('keeps a step alone in its row on one axis with the others, its lanes trailing to the right', () => {
    expect(new Set(['start', 'board', 'gate'].map(x)).size).toBe(1)
  })

  it('lays the rows out again by the cards\' measured heights: a taller card moves the rows under it down', () => {
    const measured = layoutRun(flow, overview.lanes, 'active', new Map([['board', { width: 220, height: 160 }]]))
    const at = (id: string) => measured.definition.nodes.find((node) => node.id === id)?.position.y ?? -1
    expect(at('gate') - y('gate')).toBeGreaterThan(0)
    const fixer = measured.lanes.find((lane) => lane.agent === 'fixer-3')
    // (centred on the card as it is drawn)
    expect(fixer?.position.y).toBe(at('board') + (160 - LANE_HEIGHT) / 2)
  })

  it('puts a fourth parallel lane on a second line under the first three, still beside the card', () => {
    const lane: RunLane = { agent: 'fixer-0', role: 'fixer', status: 'working', state: 'in_progress', task_id: 't0', attempt: 1, shard: null }
    const many = { board: [0, 1, 2, 3].map((n) => ({ ...lane, task_id: `t${String(n)}`, agent: `fixer-${String(n)}` })) }
    const { lanes: wrapped } = layoutRun(flow, many, 'active')
    const ys = [...new Set(wrapped.map((lane) => lane.position.y))]
    expect([wrapped.length, ys.length, wrapped.filter((lane) => lane.position.y === ys[0]).length]).toStrictEqual([4, 2, LANES_PER_LINE])
  })

  it('keeps the flow\'s edges and loops, only the steps moved', () => {
    expect([placed.edges, placed.loops]).toStrictEqual([flow.edges, flow.loops])
  })
})

describe('a lane', () => {
  it.each([
    [{ state: 'done', agent: 'a', status: 'done' }, 'active', 'ran_ok'],
    [{ state: 'failed', agent: 'a', status: 'failed' }, 'active', 'ran_failed'],
    // (7.51.04: a task at a person waits for one, never a failure)
    [{ state: 'needs_human', agent: 'a', status: 'done' }, 'active', 'waiting'],
    [{ state: 'open', agent: null, status: null }, 'active', 'planned'],
    [{ state: 'in_progress', agent: 'a', status: 'working' }, 'active', 'running'],
    [{ state: 'claimed', agent: 'a', status: null }, 'active', 'running'],
    [{ state: 'in_progress', agent: 'a', status: 'paused' }, 'active', 'paused'],
    [{ state: 'in_progress', agent: 'a', status: 'failed' }, 'active', 'ran_failed'],
    // (7.71.03: a session whose task went to a person ends needs_human, a wait for them, never a failure)
    [{ state: 'in_review', agent: 'a', status: 'needs_human' }, 'active', 'waiting'],
    [{ state: 'in_progress', agent: 'a', status: 'working' }, 'halted', 'paused'],
    [{ state: 'in_progress', agent: 'a', status: 'working' }, 'ended', 'stopped'],
  ] as const)('reads %o (the run %s) as %s', (lane, phase, state) => {
    expect(laneState(lane, phase)).toBe(state)
  })

  it('is dashed only while nothing has run on it (or held), its tone at full strength and never dimmed', () => {
    expect([laneBorder('planned').includes('border-dashed'), laneBorder('ran_ok').includes('border-dashed')]).toStrictEqual([true, false])
    const states = ['ran_ok', 'ran_failed', 'running', 'waiting', 'paused', 'stopped', 'planned'] as const
    expect(states.filter((state) => /\/\d|opacity/.test(laneBorder(state)))).toStrictEqual([])
  })

  it('is labelled by its agent, else its role, bounded', () => {
    expect([laneLabel({ agent: 'fixer-3', role: 'fixer', task_id: 't' }), laneLabel({ agent: null, role: 'fixer', task_id: 't' })])
      .toStrictEqual(['fixer-3', 'fixer'])
    expect(laneLabel({ agent: 'x'.repeat(300), role: '', task_id: 't' })).toHaveLength(100)
  })
})

describe('the gate and the steps lit', () => {
  it('reads GO as pass, NO-GO as fail and anything else as no verdict', () => {
    expect(['GO', 'NO-GO', 'unread', undefined].map(gateOutcome)).toStrictEqual(['pass', 'fail', null, null])
  })

  it('marks the gate step\'s verdict and the step the run is on, spinning while an agent is at work on it', () => {
    const states = runStepStates(overview, flow)
    expect([states.get('gate')?.gate, states.get('board')?.here, states.get('start')?.here]).toStrictEqual(['pass', 'on', undefined])
    expect(states.get('board')?.spin).toBe(true)
  })
})

describe('buildTimeline', () => {
  const { orchestrator, steps } = buildTimeline(overview, runStepStates(overview, flow))

  it('lists the steps that ran or are under way in the flow\'s order; the orchestrator on no step of the flow', () => {
    expect(steps.map((step) => [step.step, step.state])).toStrictEqual([['start', 'ok'], ['board', 'running'], ['gate', 'ok']])
    // (7.51.04: the orchestrator is the run's own row, held for a long wait here)
    expect([orchestrator?.agent, orchestrator?.status, orchestrator?.state]).toStrictEqual(['coordinator-1', 'waiting', 'paused'])
  })

  it('lists each step\'s agents with their attempts, newest first', () => {
    expect(steps.find((step) => step.step === 'board')?.agents.map((agent) => [agent.label, agent.attempts])).toStrictEqual([['fixer-3', [2, 1]]])
  })
})
