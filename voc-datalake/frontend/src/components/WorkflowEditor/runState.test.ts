/**
 * @fileoverview A run's event journal folded into per-step status (the
 * read-only run graph), and the incremental event merge.
 */
import { describe, it, expect } from 'vitest'
import { mergeEvents, stepStates } from './runState'
import type { RunEvent } from '../../api/agentsApi'
import { at } from '@test/defined'

type RunEventKind = RunEvent['kind']

const ev = (seq: number, kind: RunEventKind, nodeId?: string, summary = ''): RunEvent => ({
  seq, at: '2026-10-04T10:00:00Z', kind, summary, ...(nodeId === undefined ? {} : { node_id: nodeId }),
})

describe('stepStates', () => {
  it('is empty without events', () => {
    expect(stepStates([])).toStrictEqual(new Map())
  })

  it('marks started steps running and finished steps done', () => {
    const states = stepStates([ev(1, 'node_started', 'a'), ev(2, 'node_finished', 'a'), ev(3, 'node_started', 'b')])
    expect(states.get('a')).toStrictEqual({ status: 'done', rounds: 1 })
    expect(states.get('b')).toStrictEqual({ status: 'running', rounds: 1 })
  })

  it('counts loop rounds and runs a restarted step again', () => {
    const states = stepStates([
      ev(1, 'node_started', 'review'), ev(2, 'node_finished', 'review'), ev(3, 'node_started', 'review'),
    ])
    expect(states.get('review')).toStrictEqual({ status: 'running', rounds: 2 })
  })

  it('applies events in seq order whatever the arrival order', () => {
    const states = stepStates([ev(2, 'node_finished', 'a'), ev(1, 'node_started', 'a')])
    expect(states.get('a')?.status).toBe('done')
  })

  it('keeps the failure and the latest verdict summary', () => {
    const states = stepStates([
      ev(1, 'node_started', 'a'), ev(2, 'verdict', 'a', 'mean 3.2'), ev(3, 'decision', 'a', 'revise'),
      ev(4, 'node_started', 'b'), ev(5, 'node_failed', 'b', 'timeout'),
    ])
    expect(states.get('a')).toStrictEqual({ status: 'running', rounds: 1, lastSummary: 'revise' })
    expect(states.get('b')).toStrictEqual({ status: 'failed', rounds: 1, lastSummary: 'timeout' })
  })

  it('ignores events without a step and kinds that carry no status', () => {
    const states = stepStates([ev(1, 'message'), ev(2, 'artifact', 'a'), ev(3, 'message', 'b')])
    expect(states.size).toBe(0)
  })

  it('marks the run-reported current step running when the journal has not caught up', () => {
    expect(stepStates([], 'next').get('next')).toStrictEqual({ status: 'running', rounds: 0 })
    expect(stepStates([ev(1, 'node_started', 'a'), ev(2, 'node_finished', 'a')], 'a').get('a')?.status).toBe('done')
    expect(stepStates([], null).size).toBe(0)
  })
})

describe('mergeEvents', () => {
  it('appends a page, dedupes by seq (newest copy wins) and orders', () => {
    const merged = mergeEvents([ev(1, 'node_started', 'a'), ev(3, 'message')], [ev(3, 'message', undefined, 'updated'), ev(2, 'verdict')])
    expect(merged.map((e) => e.seq)).toStrictEqual([1, 2, 3])
    expect(at(merged, 2).summary).toBe('updated')
  })

  it('returns the known events for an empty page', () => {
    const known = [ev(1, 'node_started', 'a')]
    expect(mergeEvents(known, [])).toStrictEqual(known)
  })
})
