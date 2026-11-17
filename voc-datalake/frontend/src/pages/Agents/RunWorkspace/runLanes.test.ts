/**
 * @fileoverview The run canvas's model against the shared fixture: each step a stage in rows from the start, a step's
 * agents as sibling lanes under it that never overlap, a lane's state (and its dashed border while planned), the
 * bounded label, a gate's verdict, and the timeline of steps, agents and attempts (7.51.04: the orchestrator its own).
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
  const { definition: placed, lanes } = layoutRun(flow, overview.lanes, 'active')
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
    [{ state: 'done', agent: 'a', status: 'done' }, 'active', 'ran_ok'],
    [{ state: 'failed', agent: 'a', status: 'failed' }, 'active', 'ran_failed'],
    // (7.51.04: a task at a person waits for one, never a failure)
    [{ state: 'needs_human', agent: 'a', status: 'done' }, 'active', 'waiting'],
    [{ state: 'open', agent: null, status: null }, 'active', 'planned'],
    [{ state: 'in_progress', agent: 'a', status: 'working' }, 'active', 'running'],
    [{ state: 'claimed', agent: 'a', status: null }, 'active', 'running'],
    [{ state: 'in_progress', agent: 'a', status: 'paused' }, 'active', 'paused'],
    [{ state: 'in_progress', agent: 'a', status: 'failed' }, 'active', 'ran_failed'],
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
