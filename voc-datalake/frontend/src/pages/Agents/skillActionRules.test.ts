/** The Skills actions' rules: what a version offers, why Accept is held, and the benchmark form read. */
import { describe, it, expect } from 'vitest'
import { offeredActions, readBenchmark } from './skillActionRules'
import type { SkillVersionDetail } from '../../api/engineeringSkillsApi'

const MEASURED = { before: 0.5, after: 1, passed: true, gained: true, failure_case: 'a', cases: 1, reasons: [], run_ref: '', by: 'x', at: '' }
const version = (fields: Partial<SkillVersionDetail>): SkillVersionDetail => ({
  version: 2, status: 'proposed', summary: '', why: { run_id: '', failure: '', comment: '' }, proposed_by: 'x',
  proposed_by_kind: 'agent', proposed_at: '', accepted_by: '', accepted_at: '', rejected_by: '', rejected_at: '',
  restores: 0, base: null, benchmark: { claimed: null, measured: null }, expected_case: 'a', events: [],
  record: { instructions: '', examples: [], tool_policy: [], model: '', harness: '' },
  diff: { instructions: [], examples: [], tools_added: [], tools_removed: [], tools_reordered: false, model: null, harness: null, first: false },
  made_with: null, ...fields,
})
const FORM = { before: '50', after: '75', cases: 'a, b', passed: true, reasons: 'one\n\ntwo', failureCase: 'a', runRef: '' }

describe('the Skills actions', () => {
  it('hold Accept back for a coach\'s version until its benchmark passed with a gain', () => {
    const held = [null, { ...MEASURED, passed: false }, { ...MEASURED, gained: false }, MEASURED]
      .map((measured) => offeredActions(version({ benchmark: { claimed: null, measured } }), 1).acceptHeld)
    expect(held).toStrictEqual(['unmeasured', 'failed', 'noGain', null])
    expect(offeredActions(version({ proposed_by_kind: 'person' }), 1).acceptHeld).toBeNull()
  })

  it('offer a rollback only to an earlier accepted version while the scope has a current one', () => {
    const cases: [number, number][] = [[1, 3], [2, 2], [2, 0]]
    const rollback = cases.map(([n, current]) =>
      offeredActions(version({ status: 'accepted', version: n }), current).rollback)
    expect(rollback).toStrictEqual([true, false, false])
  })

  it('read the benchmark form: fractions, lists, and the first thing to fix', () => {
    expect(readBenchmark(FORM)).toStrictEqual({ ok: true, benchmark: {
      before: 0.5, after: 0.75, cases: ['a', 'b'], passed: true, reasons: ['one', 'two'], failure_case: 'a' } })
    expect([{ before: '101' }, { cases: 'A' }, { cases: 'a a' }, { reasons: ' ' }, { failureCase: 'c' }, { before: '90' }]
      .map((change) => readBenchmark({ ...FORM, ...change })))
      .toStrictEqual(['rates', 'cases', 'cases', 'reasons', 'failureCase', 'regressed'].map((problem) => ({ ok: false, problem })))
  })

  it('send the reference to the run only when one is given', () => {
    expect([readBenchmark({ ...FORM, runRef: ' run-7 ' }), readBenchmark(FORM)].map((read) => 'benchmark' in read && read.benchmark.run_ref))
      .toStrictEqual(['run-7', undefined])
  })
})
