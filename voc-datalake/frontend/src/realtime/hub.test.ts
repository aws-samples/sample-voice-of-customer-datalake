import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deliverNotice, isRealtimeLive, setRealtimeLive, watchRealtime } from './hub'

const JOB = { type: 'job', job_id: 'job_1', status: 'completed' } as const

beforeEach(() => {
  vi.useFakeTimers()
  setRealtimeLive(false)
})
afterEach(() => { vi.useRealTimers() })

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
