/**
 * A voice session's end as the projects API records it: posted once, retried after a failure, reported failed after
 * the last attempt and posted again on Try again; and sent with keepalive as the page goes away, unless recorded.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createEndRecorder } from './voiceSessionEnd'
import type { EndState } from './voiceSessionEnd'

function recorder(answers: Array<'ok' | 'fail'>) {
  const sent: boolean[] = []
  const states: EndState[] = []
  const post = (keepalive: boolean) => {
    sent.push(keepalive)
    return answers.shift() === 'fail' ? Promise.reject(new Error('API Error: 503')) : Promise.resolve({})
  }
  return { sent, states, end: createEndRecorder(post, (state) => states.push(state)) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createEndRecorder', () => {
  it('posts the end once, retrying a failure, and is then recorded', async () => {
    const run = recorder(['fail', 'ok'])
    run.end.record()
    run.end.record()
    await vi.advanceTimersByTimeAsync(2000)
    expect([run.sent, run.states]).toStrictEqual([[false, false], ['posting', 'yes']])
  })

  it('says failed after three attempts, and Try again posts it again', async () => {
    const run = recorder(['fail', 'fail', 'fail', 'ok'])
    run.end.record()
    await vi.advanceTimersByTimeAsync(6000)
    expect(run.states).toStrictEqual(['posting', 'failed'])
    run.end.record()
    await vi.advanceTimersByTimeAsync(0)
    expect([run.sent.length, run.states.at(-1)]).toStrictEqual([4, 'yes'])
  })

  it('sends the end with keepalive as the page goes away, unless it was recorded', async () => {
    const closing = recorder(['fail'])
    closing.end.pageHidden()
    const recorded = recorder(['ok'])
    recorded.end.record()
    await vi.advanceTimersByTimeAsync(0)
    recorded.end.pageHidden()
    expect([closing.sent, recorded.sent]).toStrictEqual([[true], [false]])
  })
})
