import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { parseNotice } from './events'
import { deliverNotice, isRealtimeLive, resetRealtimeHub, setRealtimeLive, watchRealtime } from './hub'

const JOB = { type: 'job', job_id: 'job_1', status: 'completed' } as const

beforeEach(() => {
  vi.useFakeTimers()
  resetRealtimeHub()
})
afterEach(() => { vi.useRealTimers() })

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

describe('watchRealtime', () => {
  it('is a plain sleep while push is off', async () => {
    const watch = watchRealtime(() => true)
    const woke = watch.wait(1000)
    await vi.advanceTimersByTimeAsync(1000)
    await expect(woke).resolves.toBe('timeout')
    expect(isRealtimeLive()).toBe(false)
    watch.close()
  })

  it('wakes on a matching notice at once, and ignores the others', async () => {
    const watch = watchRealtime((n) => n.type === 'job' && n.job_id === 'job_1')
    const woke = watch.wait(10_000)
    deliverNotice({ ...JOB, job_id: 'job_2' })
    deliverNotice(JOB)
    await expect(woke).resolves.toBe('notice')
    watch.close()
  })

  it('keeps a notice that arrived between two waits', async () => {
    const watch = watchRealtime(() => true)
    deliverNotice(JOB)
    await expect(watch.wait(10_000)).resolves.toBe('notice')
    watch.close()
  })

  it('wakes on a (re)connect, once per false → true change', async () => {
    const watch = watchRealtime(() => false)
    const woke = watch.wait(10_000)
    setRealtimeLive(true)
    await expect(woke).resolves.toBe('reconnect')
    setRealtimeLive(true)
    const next = watch.wait(500)
    await vi.advanceTimersByTimeAsync(500)
    await expect(next).resolves.toBe('timeout')
    watch.close()
  })

  it('rejects with an AbortError when the signal aborts, and hears nothing after close', async () => {
    const watch = watchRealtime(() => true)
    const controller = new AbortController()
    const woke = watch.wait(10_000, controller.signal)
    controller.abort()
    await expect(woke).rejects.toMatchObject({ name: 'AbortError' })
    watch.close()
    deliverNotice(JOB)
    const after = watch.wait(100)
    await vi.advanceTimersByTimeAsync(100)
    await expect(after).resolves.toBe('timeout')
  })
})
