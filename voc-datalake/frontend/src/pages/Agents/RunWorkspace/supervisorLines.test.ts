/**
 * @fileoverview The supervisor's lines read for a person (7.51.04): each known shape (as runtime/supervisor.py and
 * board_bus.py word them) read into what it says, an unknown one left alone, and a run of the same health line in a
 * row folded into its latest.
 */
import { describe, expect, it } from 'vitest'
import { foldRepeats, readSupervisorLine } from './supervisorLines'
import type { ThreadItem } from '../../../api/engineeringRunWorkspaceApi'

describe('readSupervisorLine', () => {
  it.each([
    ['1 booting (tokens 0, cost_usd 0.00)', { kind: 'health', costUsd: 0, counts: [{ status: 'booting', count: 1 }] }],
    ['1 booting, 2 working (tokens 1200, cost_usd 0.41)',
      { kind: 'health', costUsd: 0.41, counts: [{ status: 'booting', count: 1 }, { status: 'working', count: 2 }] }],
    ['1 failed (tokens 0, cost_usd 0.03)', { kind: 'health', costUsd: 0.03, counts: [{ status: 'failed', count: 1 }] }],
    ['coordinator-1 continued in a new session (1). (continuation 1, after crash, checkpoint none)',
      { kind: 'restarted', agent: 'coordinator-1', attempt: 2 }],
    ['fixer-3 continued in a new session (4). (continuation 4, after pause, checkpoint ws/default/runs/r/ck.json)',
      { kind: 'continued', agent: 'fixer-3' }],
    ['coordinator-1 crashed 3 times.', { kind: 'failedOut', agent: 'coordinator-1', times: 3 }],
    ['coordinator-1 could not start. The repository checkout failed (git clone, exit 128): fatal: dubious ownership',
      { kind: 'couldNotStart', agent: 'coordinator-1', reason: 'The repository checkout failed (git clone, exit 128): fatal: dubious ownership' }],
    ['fixer-3 stopped answering.', { kind: 'notAnswering', agent: 'fixer-3' }],
    ['fixer-3 found no free agent session 5 times in a row: held for a person.', { kind: 'noRoom', agent: 'fixer-3', times: 5 }],
    ['Stopped: 2 session(s) ended.', { kind: 'stopped', sessions: 2 }],
  ])('reads %j', (text, line) => {
    expect(readSupervisorLine(text)).toStrictEqual(line)
  })

  it.each([
    'The run started.', 'Stopped from the run monitor: 3 session(s) ended, 2 task(s) closed.', 'booting (tokens 0, cost_usd 0.00)',
    '1 booting (tokens x, cost_usd 0.00)', '1 booting (tokens 0, cost_usd )', 'One booting (tokens 0, cost_usd 0.00)',
    'fixer-1 is held: the checkout cache has no usable entry of the run\'s commit. A Resume of the run fills it, then continues its agents.',
  ])('leaves a line of no known shape alone: %j', (text) => {
    expect(readSupervisorLine(text)).toBeNull()
  })
})

const item = (ref: string, text: string, kind = 'supervisor'): ThreadItem => ({
  ref, at: `2026-11-17T09:00:0${ref.slice(1)}Z`, kind: 'message', from: { kind, id: kind }, text, cut: false, update: '', tool: null,
})

describe('foldRepeats', () => {
  it('folds a run of the same health line into its latest, whatever its cost, and keeps every other line', () => {
    const items = [
      item('c1', '1 booting (tokens 0, cost_usd 0.00)'), item('c2', '1 booting (tokens 0, cost_usd 0.00)'),
      item('c3', '1 booting (tokens 0, cost_usd 0.01)'),
      item('c4', 'coordinator-1 continued in a new session (1). (continuation 1, after crash, checkpoint none)'),
      item('c5', '1 booting (tokens 0, cost_usd 0.01)'), item('c6', '1 failed (tokens 0, cost_usd 0.03)'),
      item('c7', '1 failed (tokens 0, cost_usd 0.03)', 'agent'),
    ]
    expect(foldRepeats(items).map(({ key, item: shown, said }) => [key, shown.ref, said.length])).toStrictEqual([
      ['c1', 'c3', 3], ['c4', 'c4', 1], ['c5', 'c5', 1], ['c6', 'c6', 1], ['c7', 'c7', 1],
    ])
  })

  it('folds nothing in a thread with no repeat', () => {
    const items = [item('c1', 'The run started.'), item('c2', 'The run started.')]
    expect(foldRepeats(items).map(({ said }) => said.length)).toStrictEqual([1, 1])
  })
})
