/**
 * @fileoverview The run canvas's model against the shared fixture: each step a stage in rows from the start, a step's
 * agents as sibling lanes under it that never overlap, a lane's state (and its dashed border while planned), the
 * bounded label, a gate's verdict, and the timeline of steps, agents and attempts.
 */
import { describe, expect, it } from 'vitest'
import fixture from '@test/engineeringRunWorkspace.json'
import { parseOverview } from '../../../api/engineeringRunsApi'
import { laneBorder } from '../../../components/WorkflowEditor/runState'
import { LANE_WIDTH, gateOutcome, laneLabel, laneState, layoutRun } from './runLanes'
import { buildTimeline } from './runTimelineModel'
import { runStepStates } from './runFlow'
import type { WorkflowDefinition } from '../../../api/workflowsApi'

const overview = parseOverview(fixture.overview.answer)
const definition: WorkflowDefinition | null = overview.run.flow_definition
const flow = definition ?? { nodes: [], edges: [], loops: [], name: '', schema: 'voc-workflow/2' }

describe('layoutRun', () => {
  const { definition: placed, lanes } = layoutRun(flow, overview.lanes, false)
  const y = (id: string) => placed.nodes.find((node) => node.id === id)?.position.y ?? -1

  it('stacks the stages from the start along the flow, the gate\'s two ways side by side', () => {
    expect([y('start') < y('board'), y('board') < y('gate'), y('gate') < y('pr')]).toStrictEqual([true, true, true])
    expect(y('pr')).toBe(y('human'))
  })

  it('places each step\'s agents as lanes under it, siblings side by side that never overlap', () => {
    const gate = lanes.filter((lane) => lane.step === 'gate')
    expect(lanes.map((lane) => [lane.step, lane.agent])).toStrictEqual([['board', 'fixer-3'], ['gate', 'gate-runner-4'], ['gate', 'final-go-5']])
    expect((gate[1]?.position.x ?? 0) - (gate[0]?.position.x ?? 0)).toBeGreaterThanOrEqual(LANE_WIDTH)
    expect(gate.every((lane) => lane.position.y > y('gate') && lane.position.y < y('pr'))).toBe(true)
  })

  it('keeps the flow\'s edges and loops, only the steps moved', () => {
    expect([placed.edges, placed.loops]).toStrictEqual([flow.edges, flow.loops])
  })
})

describe('a lane', () => {
  it.each([
    [{ state: 'done', agent: 'a' }, false, 'ran_ok'],
    [{ state: 'failed', agent: 'a' }, false, 'ran_failed'],
    [{ state: 'needs_human', agent: 'a' }, false, 'ran_failed'],
    [{ state: 'open', agent: null }, false, 'planned'],
    [{ state: 'in_progress', agent: 'a' }, false, 'running'],
    [{ state: 'in_progress', agent: 'a' }, true, 'stopped'],
  ])('reads %o (the run ended: %s) as %s', (lane, ended, state) => {
    expect(laneState(lane, ended)).toBe(state)
  })

  it('is dashed only while nothing has run on it', () => {
    expect([laneBorder('planned').includes('border-dashed'), laneBorder('ran_ok').includes('border-dashed')]).toStrictEqual([true, false])
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

  it('marks the gate step\'s verdict and the step the run is on', () => {
    const states = runStepStates(overview, flow)
    expect([states.get('gate')?.gate, states.get('board')?.here, states.get('start')?.here]).toStrictEqual(['pass', true, undefined])
  })
})

describe('buildTimeline', () => {
  const steps = buildTimeline(overview, runStepStates(overview, flow))

  it('lists the steps that ran or are under way in the flow\'s order, then the agents on no step', () => {
    expect(steps.map((step) => [step.step, step.state])).toStrictEqual([['start', 'ok'], ['board', 'running'], ['gate', 'ok'], ['', 'running']])
  })

  it('lists each step\'s agents with their attempts, newest first', () => {
    expect(steps.find((step) => step.step === 'board')?.agents.map((agent) => [agent.label, agent.attempts])).toStrictEqual([['fixer-3', [2, 1]]])
    expect(steps.at(-1)?.agents.map((agent) => agent.agent)).toStrictEqual(['coordinator-1'])
  })
})
