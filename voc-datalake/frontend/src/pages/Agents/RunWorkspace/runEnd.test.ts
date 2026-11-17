/**
 * @fileoverview A run that stopped, as the workspace says it (7.51.04), against the shared fixture: the banner's words
 * for each state it stopped in (with the supervisor's reason, with only the agent's last exit, with nothing), the
 * steps lit from the run's real state (where it stopped, in which state, no spinner once it ended or waits for a
 * person, none while nobody is at work on a step), and the timeline's orchestrator row and its steps with no agent.
 */
import { describe, expect, it } from 'vitest'
import fixture from '@test/engineeringRunWorkspace.json'
import { parseOverview } from '../../../api/engineeringRunsApi'
import { runEnd } from './runEnd'
import { runStepStates } from './runFlow'
import { buildTimeline } from './runTimelineModel'
import type { EngineeringOverview } from '../../../api/engineeringRunsApi'
import type { WorkflowDefinition } from '../../../api/workflowsApi'

const live = fixture.overview.answer
const failed = parseOverview(fixture.failed_overview.answer)
const EXIT = { exit_code: 128, timed_out: false, duration_seconds: 2, stderr_tail: 'fatal: detected dubious ownership' }

/** The live run as it would read in `run`, its coordinator (and fixer) changed by `agents`. */
function liveAs(run: Record<string, unknown>, agents: Record<string, Record<string, unknown>> = {}, extra: Record<string, unknown> = {}) {
  return parseOverview({
    ...live, ...extra, run: { ...live.run, ...run },
    agents: live.agents.map((agent) => ({ ...agent, ...agents[agent.agent] })),
  })
}

const flowOf = (overview: EngineeringOverview): WorkflowDefinition => {
  const definition = overview.run.flow_definition
  if (definition === null) throw new Error('the fixture run has a flow')
  return definition
}

/** Each lit step's [status, here, spin] (unset ones left out). */
const lit = (overview: EngineeringOverview) => Object.fromEntries([...runStepStates(overview, flowOf(overview)).entries()]
  .map(([step, state]) => [step, [state.status, state.here ?? null, state.spin ?? null]]))

describe('runEnd', () => {
  it('says nothing of a run under way or one that finished', () => {
    expect([runEnd(parseOverview(live)), runEnd(liveAs({ status: 'done', ended_at: '2026-11-17T10:00:00Z' }))]).toStrictEqual([null, null])
  })

  it('says a checkout failed, by whom, why in the supervisor\'s words, its last exit, and Resume (the failed run)', () => {
    expect(runEnd(failed)).toMatchObject({
      status: 'needs_human', tone: 'danger', what: 'checkoutFailed', orchestrator: true,
      reason: failed.run.waiting_detail, exit: { exit_code: 128 }, next: 'resume',
    })
    expect(runEnd(failed)?.agent?.agent).toBe('coordinator-1')
  })

  it('falls back to the agent\'s last exit when no reason was stored, and to nothing said when there is none', () => {
    const exited = runEnd(liveAs({ status: 'needs_human', waiting_at: 'coordinator' }, { 'coordinator-1': { status: 'failed', last_exit: EXIT } }))
    expect(exited).toMatchObject({ tone: 'danger', what: 'orchestratorFailed', reason: null, exit: EXIT })
    const silent = runEnd(liveAs({ status: 'needs_human', waiting_at: 'coordinator' }, { 'coordinator-1': { status: 'failed' } }))
    expect(silent).toMatchObject({ what: 'orchestratorFailed', reason: null, exit: null })
    const told = runEnd(liveAs({ status: 'needs_human', waiting_at: 'coordinator' },
      { 'coordinator-1': { status: 'failed', last_failure: 'the boot took too long' } }))
    expect(told?.reason).toBe('the boot took too long')
  })

  it.each([
    [{ waiting_at: 'budget' }, {}, 'budget', 'resumeBudget'],
    [{ waiting_at: 'thirty_days' }, {}, 'thirtyDays', 'stopThenRestart'],
    [{ waiting_at: 'coordinator' }, {}, 'orchestratorNotStarted', 'resume'],
    [{ waiting_at: 'budget' }, { signals_available: false }, 'budget', 'stopThenRestart'],
    [{ waiting_at: 'budget' }, { signals_available: false, stop_available: false }, 'budget', 'nothing'],
  ])('waits for a person\'s decision in warn: %o %o', (run, extra, what, next) => {
    expect(runEnd(liveAs({ status: 'needs_human', ...run }, {}, extra))).toMatchObject({ tone: 'warn', what, next, agent: null, reason: null })
  })

  it('says why a flow waits at a step in the conductor\'s words', () => {
    const atStep = runEnd(liveAs({ status: 'needs_human', waiting_at: 'flow:gate',
      flow_outcome: { outcome: 'needs_human', at: 'gate', reason: 'the final go answered NO-GO' } }))
    expect(atStep).toMatchObject({ tone: 'warn', what: 'flowStep', reason: 'the final go answered NO-GO' })
  })

  it('says a failed run failed, by whom when an agent did, and Restart run', () => {
    const byFixer = runEnd(liveAs({ status: 'failed', ended_at: '2026-11-17T10:00:00Z' }, { 'fixer-3': { status: 'failed', last_failure: 'the session stopped answering' } }))
    expect(byFixer).toMatchObject({ status: 'failed', tone: 'danger', what: 'runFailedAgent', orchestrator: false,
      reason: 'the session stopped answering', next: 'restart' })
    expect(runEnd(liveAs({ status: 'failed', ended_at: '2026-11-17T10:00:00Z' }))).toMatchObject({ what: 'runFailed', agent: null, reason: null })
  })

  it('says a person stopped it, in the muted tone, with no failure blamed', () => {
    const at = '2026-11-17T10:00:00Z'
    expect(runEnd(liveAs({ status: 'stopped', ended_at: at, stop: { mode: 'stop', requested_at: at } }, { 'fixer-3': { status: 'failed' } })))
      .toMatchObject({ status: 'stopped', tone: 'muted', what: 'stopped', agent: null, next: 'restart' })
    expect(runEnd(liveAs({ status: 'stopped', ended_at: at, stop: { mode: 'stop_now', requested_at: at } }))?.what).toBe('stoppedNow')
  })
})

describe('the steps of a run that stopped', () => {
  it('marks where the failed run stopped as failed, with no spinner anywhere', () => {
    expect(lit(failed)).toStrictEqual({ start: ['done', null, null], classify: ['failed', 'stopped', false] })
  })

  it('marks a run at a person\'s decision as waiting where it stopped, and holds its agents', () => {
    const halted = liveAs({ status: 'needs_human', waiting_at: 'budget' })
    expect(lit(halted).board).toStrictEqual(['waiting', 'stopped', false])
    expect(Object.values(lit(halted)).some(([status]) => status === 'running')).toBe(false)
    expect(buildTimeline(halted, runStepStates(halted, flowOf(halted))).steps.find((step) => step.step === 'board')?.agents[0]?.state)
      .toBe('paused')
  })

  it('marks a stopped run as stopped where it stopped, and nothing where a finished one ended', () => {
    const at = '2026-11-17T10:00:00Z'
    expect(lit(liveAs({ status: 'stopped', ended_at: at })).board).toStrictEqual(['stopped', 'stopped', false])
    expect(Object.values(lit(liveAs({ status: 'done', ended_at: at }))).map(([, here]) => here)).not.toContain('stopped')
  })

  it('spins a step under way only while an agent is at work on it', () => {
    const idle = liveAs({}, {}, { lanes: { ...live.lanes, board: [{ ...live.lanes.board[0], status: 'paused' }] } })
    expect(lit(idle).board).toStrictEqual(['running', 'on', false])
    expect(buildTimeline(idle, runStepStates(idle, flowOf(idle))).steps.find((step) => step.step === 'board')?.state).toBe('ready')
  })
})

describe('the timeline of the failed run', () => {
  const { orchestrator, steps } = buildTimeline(failed, runStepStates(failed, flowOf(failed)))

  it('gives the orchestrator its own row, never "on no step of the flow"', () => {
    expect([orchestrator?.agent, orchestrator?.status, orchestrator?.state]).toStrictEqual(['coordinator-1', 'failed', 'ran_failed'])
    expect(steps.map((step) => step.step)).not.toContain('')
  })

  it('lists the step where it stopped with no agent on it', () => {
    expect(steps.map((step) => [step.step, step.state, step.here ?? null, step.agents.length])).toStrictEqual([
      ['start', 'ok', null, 0], ['classify', 'failed', 'stopped', 0],
    ])
  })
})
