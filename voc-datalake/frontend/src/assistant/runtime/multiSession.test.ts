/**
 * Several conversations at once: each thread runs on its own, a run keeps
 * writing to the thread it started on after the user switches away, a finished
 * background run is marked unread, stopping/closing one leaves the others
 * running, and the open-conversation cap never evicts a running thread.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventType } from '@ag-ui/core'
import { answerRun } from '@test/assistantDoubles'
import type { PendingRun } from '@test/assistantDoubles'

const agent = await vi.hoisted(async () => (await import('@test/assistantDoubles')).createPendingRunAgent({ rejectOnAbort: true }))
const pendingRuns = agent.runs

vi.mock('../agui/client', agent.clientModule)
vi.mock('../sessions/sessionsApi', agent.sessionsModule)

import { closeThread, newThread, openSession, resolveApproval, sendMessage, stopRun } from './runtime'
import { MAX_OPEN_THREADS, useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { saveSession } from '../sessions/sessionsApi'
import type { RunEnvironment } from './runtime'

const env: RunEnvironment = { page: { kind: 'chat', path: '/chat' }, useWebSearch: false }

function store() {
  return useThreadStore.getState()
}

function slot(threadId: string) {
  const found = store().slots[threadId]
  if (found === undefined) throw new Error(`thread ${threadId} is not open`)
  return found
}

function runFor(threadId: string): PendingRun {
  const run = pendingRuns.find((r) => r.input.threadId === threadId)
  if (run === undefined) throw new Error(`no run for ${threadId}`)
  return run
}

/** Finish a run with one assistant text message. */
function answer(run: PendingRun, messageId: string, text: string): void {
  answerRun(run, messageId, text)
  run.finish()
}

function lastText(threadId: string): unknown {
  return slot(threadId).thread.messages.at(-1)?.content
}

/** Start a run in the thread in view and return its id once its stream has been requested. */
async function startRun(text: string): Promise<{ id: string; done: Promise<void> }> {
  const id = store().activeId
  const done = sendMessage(text, env)
  // The question is saved first; the stream is requested only once that save has landed.
  await vi.waitFor(() => expect(pendingRuns.some((r) => r.input.threadId === id)).toBe(true))
  expect(slot(id).thread.status).toBe('streaming')
  return { id, done }
}

describe('multiple assistant sessions', () => {
  beforeEach(() => {
    pendingRuns.length = 0
    vi.mocked(saveSession).mockClear()
    store().reset()
  })

  it('runs two conversations at the same time, each on its own thread', async () => {
    const first = await startRun('first question')
    newThread()
    const second = await startRun('second question')

    expect(second.id).not.toBe(first.id)
    expect(slot(first.id).thread.status).toBe('streaming')
    expect(slot(second.id).thread.status).toBe('streaming')
    expect(pendingRuns.map((r) => r.input.threadId)).toStrictEqual([first.id, second.id])
  })

  it('a run that finishes in the background lands on its own thread and is marked unread', async () => {
    const first = await startRun('first question')
    newThread()
    const secondId = store().activeId

    answer(runFor(first.id), 'a1', 'first answer')
    await first.done

    expect(lastText(first.id)).toBe('first answer')
    expect(slot(first.id).unread).toBe(true)
    expect(store().activeId).toBe(secondId)
    expect(store().thread.messages).toStrictEqual([])
  })

  it('a background run is saved under its own session id', async () => {
    const first = await startRun('first question')
    newThread()
    answer(runFor(first.id), 'a1', 'first answer')
    await first.done
    expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({ id: first.id }))
  })

  it('switching back clears the unread mark and shows the finished answer', async () => {
    const first = await startRun('first question')
    newThread()
    answer(runFor(first.id), 'a1', 'first answer')
    await first.done

    await openSession(first.id, env)

    expect(store().activeId).toBe(first.id)
    expect(slot(first.id).unread).toBe(false)
    expect(store().thread.messages.at(-1)?.content).toBe('first answer')
  })

  it('a conversation in view is never marked unread', async () => {
    const only = await startRun('question')
    answer(runFor(only.id), 'a1', 'answer')
    await only.done
    expect(slot(only.id).unread).toBe(false)
  })

  it('stopping one conversation leaves the other running', async () => {
    const first = await startRun('first question')
    newThread()
    const second = await startRun('second question')

    stopRun(null, first.id)
    await first.done

    expect(slot(first.id).thread.status).toBe('idle')
    expect(slot(second.id).thread.status).toBe('streaming')
  })

  it('closing a running conversation aborts it and keeps the other one in view', async () => {
    const first = await startRun('first question')
    newThread()
    const second = await startRun('second question')

    closeThread(first.id)
    await first.done

    expect(Object.keys(store().slots)).toStrictEqual([second.id])
    expect(store().activeId).toBe(second.id)
    expect(slot(second.id).thread.status).toBe('streaming')
  })

  it('closing the conversation in view brings the most recent other one into view', async () => {
    const first = await startRun('first question')
    newThread()
    const second = await startRun('second question')

    closeThread(second.id)
    await second.done

    expect(store().activeId).toBe(first.id)
  })

  it('"New chat" on an empty conversation reuses it instead of piling up blanks', () => {
    const before = store().activeId
    newThread()
    newThread()
    expect(store().activeId).toBe(before)
    expect(store().order).toStrictEqual([before])
  })

  it('an approval answered for a background conversation resumes that conversation, not the one in view', async () => {
    const first = await startRun('rename the project')
    const run = runFor(first.id)
    run.emit({ type: EventType.RUN_STARTED, threadId: first.id, runId: run.input.runId })
    run.emit({ type: EventType.TOOL_CALL_START, toolCallId: 'w1', toolCallName: 'update_project', parentMessageId: 'a1' })
    run.emit({ type: EventType.TOOL_CALL_ARGS, toolCallId: 'w1', delta: '{"project_id":"p1","name":"B"}' })
    run.emit({ type: EventType.TOOL_CALL_END, toolCallId: 'w1' })
    run.emit({
      type: EventType.RUN_FINISHED,
      threadId: first.id,
      runId: run.input.runId,
      outcome: { type: 'interrupt', interrupts: [{ id: 'approval:w1', reason: 'tool_approval', toolCallId: 'w1', expiresAt: '2999-01-01T00:00:00Z' }] },
    })
    run.finish()
    await first.done
    newThread()
    const inView = store().activeId

    resolveApproval({ interruptId: 'approval:w1', toolCallId: 'w1', outcome: { status: 'executed', summary: 'renamed' } }, env, first.id)

    expect(pendingRuns.at(-1)?.input).toMatchObject({ threadId: first.id, resume: [{ interruptId: 'approval:w1', status: 'resolved' }] })
    expect(slot(first.id).thread.status).toBe('streaming')
    expect(store().activeId).toBe(inView)
    expect(store().thread.messages).toStrictEqual([])
  })

  it('events for a conversation that was closed are dropped instead of reopening it', () => {
    const id = store().activeId
    newThread()
    store().dispatchTo(id, { type: 'local/user_message', message: { id: 'u', role: 'user', content: 'x' } })
    closeThread(id)
    expect(store().dispatchTo(id, { type: 'local/aborted' })).toBeNull()
    expect(Object.hasOwn(store().slots, id)).toBe(false)
  })

  it('activate reports false for a conversation that is not open', () => {
    expect(store().activate('not-open')).toBe(false)
  })

  it('a background run that ends shows a desktop notification when the user opted in', async () => {
    const constructed = vi.fn()
    vi.stubGlobal('Notification', Object.assign(function FakeNotification(title: string) { constructed(title) }, { permission: 'granted' }))
    useAssistantUiStore.getState().setNotify(true)
    try {
      const first = await startRun('first question')
      newThread()
      answer(runFor(first.id), 'a1', 'first answer')
      await first.done
      expect(constructed).toHaveBeenCalledExactlyOnceWith('The assistant replied')
    } finally {
      vi.unstubAllGlobals()
      useAssistantUiStore.getState().reset()
    }
  })

  it('caps open conversations by evicting the oldest idle one, never a running one', async () => {
    const running = await startRun('keeps running')
    const idle: string[] = []
    for (const n of Array.from({ length: MAX_OPEN_THREADS - 1 }, (_, i) => i + 1)) {
      newThread()
      const run = await startRun(`question ${n}`)
      answer(runFor(run.id), `a${n}`, `answer ${n}`)
      await run.done
      idle.push(run.id)
    }

    newThread()

    expect(store().order).toHaveLength(MAX_OPEN_THREADS)
    expect(store().order).toContain(running.id)
    expect(store().order).not.toContain(idle[0])
    expect(slot(running.id).thread.status).toBe('streaming')
  })
})
