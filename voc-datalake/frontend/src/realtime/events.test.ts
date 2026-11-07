import { describe, expect, it } from 'vitest'
import { parseNotice } from './events'

const JOB = { type: 'job', job_id: 'job_1', status: 'completed' } as const

describe('parseNotice', () => {
  it('reads the four notice kinds from an AppSync delivery, whether the event is a string or parsed', () => {
    expect(parseNotice({ id: 'x', event: JSON.stringify(JOB) })).toStrictEqual(JOB)
    expect(parseNotice({ event: { type: 'session', conversation_id: 'c1', run_status: 'finished', revision: 3 } }))
      .toMatchObject({ type: 'session', revision: 3 })
    expect(parseNotice({ event: { type: 'run', agent_id: 'a', run_id: 'r', status: 'running' } })).toMatchObject({ type: 'run' })
    expect(parseNotice({ event: { type: 'plan', plan_id: 'p', change: 'plan_finished' } })).toMatchObject({ type: 'plan' })
  })

  it('drops anything else (unknown type, missing ids, bad JSON, a negative revision)', () => {
    const rejected = [
      { event: { type: 'other' } }, { event: { type: 'job', status: 'x' } }, { event: '{not json' },
      { event: { type: 'session', conversation_id: 'c', run_status: 'x', revision: -1 } }, null, 'text',
    ].map(parseNotice)
    expect(rejected).toStrictEqual([null, null, null, null, null, null])
  })
})
