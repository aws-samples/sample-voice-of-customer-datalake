/**
 * Assistant stores: the persisted UI preferences (partialize / merge of a
 * tampered record) and the in-memory open threads (unread marking, eviction,
 * open / close / activate, sign-out reset).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Message } from '@ag-ui/core'
import { useAuthStore } from '../../store/authStore'
import { createThreadState } from '../thread/reducer'
import type { ThreadState } from '../thread/types'
import { MAX_OPEN_THREADS, onAssistantSignOut, useAssistantUiStore, useThreadStore } from './assistantStore'

const USER_MESSAGE: Message = { id: 'm1', role: 'user', content: 'hi' }

function threads() {
  return useThreadStore.getState()
}

function mergeUi(persisted: unknown) {
  const merge = useAssistantUiStore.persist.getOptions().merge
  if (merge === undefined) throw new Error('merge is not configured')
  return merge(persisted, useAssistantUiStore.getState())
}

function awaitingApproval(threadId: string): ThreadState {
  return { ...createThreadState(threadId), status: 'awaiting_approval' }
}

/** Open `ids` in order (the last one ends up in view). */
function openAll(ids: string[]): void {
  ids.forEach((id) => threads().replace(createThreadState(id), '2026-01-01T00:00:00.000Z'))
}

function idsFrom(prefix: string, count: number): string[] {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`)
}

beforeEach(() => {
  useAssistantUiStore.getState().reset()
  threads().reset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAssistantUiStore persistence', () => {
  it('persists exactly the five UI preferences under voc-assistant-ui', () => {
    useAssistantUiStore.setState({ open: true, mode: 'expanded', useWebSearch: true, notify: true, activeThreadId: 't1' })
    const options = useAssistantUiStore.persist.getOptions()
    expect(options.name).toBe('voc-assistant-ui')
    expect(options.partialize?.(useAssistantUiStore.getState())).toStrictEqual({
      open: true, mode: 'expanded', useWebSearch: true, notify: true, activeThreadId: 't1',
    })
  })

  it('resets notifications to off', () => {
    useAssistantUiStore.getState().setNotify(true)
    useAssistantUiStore.getState().reset()
    expect(useAssistantUiStore.getState().notify).toBe(false)
  })

  it('resets web search to off', () => {
    useAssistantUiStore.getState().setUseWebSearch(true)
    expect(useAssistantUiStore.getState().useWebSearch).toBe(true)
    useAssistantUiStore.getState().reset()
    expect(useAssistantUiStore.getState().useWebSearch).toBe(false)
  })

  it('keeps the current state when the stored record is null', () => {
    expect(mergeUi(null)).toBe(useAssistantUiStore.getState())
  })

  it('keeps the current state when the stored record is not an object', () => {
    expect(mergeUi('open')).toBe(useAssistantUiStore.getState())
  })

  it('restores notify only when the stored value is exactly true', () => {
    expect(mergeUi({ notify: true }).notify).toBe(true)
    expect(mergeUi({ notify: 'true' }).notify).toBe(false)
    expect(mergeUi({ notify: false }).notify).toBe(false)
  })

  it('restores a valid record field by field', () => {
    expect(mergeUi({ open: true, mode: 'fullscreen', useWebSearch: true, activeThreadId: 't9' })).toMatchObject({
      open: true, mode: 'fullscreen', useWebSearch: true, activeThreadId: 't9',
    })
  })

  it('drops a tampered record back to safe values', () => {
    expect(mergeUi({ open: 1, mode: 'giant', useWebSearch: 'yes', activeThreadId: 42 })).toMatchObject({
      open: false, mode: 'bubble', useWebSearch: false, activeThreadId: null,
    })
  })
})

describe('useThreadStore', () => {
  it('starts each fresh slot empty, idle, read and timestamped', () => {
    const { thread, createdAt, slots, activeId } = threads()
    expect(thread.messages).toStrictEqual([])
    expect(thread.status).toBe('idle')
    expect(slots[activeId]?.unread).toBe(false)
    expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('replace opens the thread in view with the given createdAt', () => {
    threads().replace(createThreadState('t1'), '2025-05-05T00:00:00.000Z')
    expect(threads().activeId).toBe('t1')
    expect(threads().createdAt).toBe('2025-05-05T00:00:00.000Z')
  })

  it('replace without createdAt stamps the current time', () => {
    vi.useFakeTimers({ now: new Date('2026-03-04T05:06:07.000Z') })
    threads().replace(createThreadState('t1'))
    expect(threads().createdAt).toBe('2026-03-04T05:06:07.000Z')
  })

  it('replace of an already open thread does not duplicate it in the order', () => {
    openAll(['t1', 't2'])
    threads().replace(createThreadState('t1'))
    expect(threads().order.slice(1)).toStrictEqual(['t2', 't1'])
  })

  it('dispatch returns the new active thread state', () => {
    const next = threads().dispatch({ type: 'local/user_message', message: USER_MESSAGE })
    expect(next.messages).toStrictEqual([USER_MESSAGE])
    expect(threads().thread).toBe(next)
  })

  it('activate brings an open thread into view and reports true', () => {
    openAll(['t1', 't2'])
    expect(threads().activate('t1')).toBe(true)
    expect(threads().activeId).toBe('t1')
  })

  it('activate of a thread that is not open reports false', () => {
    expect(threads().activate('missing')).toBe(false)
  })

  it('noteSaved bumps saveTick by one each time', () => {
    threads().noteSaved()
    threads().noteSaved()
    expect(threads().saveTick).toBe(2)
  })
})

describe('useThreadStore unread marking', () => {
  beforeEach(() => {
    openAll(['bg', 'fg'])
  })

  it('marks a background thread unread when its run ends', () => {
    threads().dispatchTo('bg', { type: 'local/run_requested', runId: 'r1' })
    threads().dispatchTo('bg', { type: 'local/stream_closed' })
    expect(threads().slots.bg?.unread).toBe(true)
  })

  it('does not mark a background thread unread for a step that starts no run', () => {
    threads().dispatchTo('bg', { type: 'local/user_message', message: USER_MESSAGE })
    expect(threads().slots.bg?.unread).toBe(false)
  })

  it('does not mark a background thread unread when its run starts', () => {
    threads().dispatchTo('bg', { type: 'local/run_requested', runId: 'r1' })
    expect(threads().slots.bg?.unread).toBe(false)
  })

  it('does not mark a background thread unread while it keeps streaming', () => {
    threads().dispatchTo('bg', { type: 'local/run_requested', runId: 'r1' })
    threads().dispatchTo('bg', { type: 'local/run_requested', runId: 'r2' })
    expect(threads().slots.bg?.unread).toBe(false)
  })

  it('does not mark the thread in view unread when its run fails', () => {
    threads().dispatch({ type: 'local/run_requested', runId: 'r1' })
    threads().dispatch({ type: 'local/failed', error: { message: 'boom' } })
    expect(threads().slots.fg?.unread).toBe(false)
  })
})

describe('useThreadStore eviction', () => {
  it(`evicts the oldest idle thread when opening one more than ${MAX_OPEN_THREADS}`, () => {
    const firstId = threads().activeId
    openAll(idsFrom('t', MAX_OPEN_THREADS))
    expect(threads().order).toHaveLength(MAX_OPEN_THREADS)
    expect(threads().order).not.toContain(firstId)
    expect(threads().slots).not.toHaveProperty(firstId)
  })

  it('never evicts the thread in view', () => {
    const firstId = threads().activeId
    openAll(idsFrom('t', MAX_OPEN_THREADS - 1))
    threads().activate(firstId)
    openAll(['extra'])
    expect(threads().order).toContain(firstId)
    expect(threads().order).not.toContain('t1')
  })

  it('never evicts a streaming thread', () => {
    const firstId = threads().activeId
    threads().dispatch({ type: 'local/run_requested', runId: 'r1' })
    openAll(idsFrom('t', MAX_OPEN_THREADS))
    expect(threads().order).toContain(firstId)
    expect(threads().order).not.toContain('t1')
  })

  it('never evicts a thread awaiting approval', () => {
    const firstId = threads().activeId
    threads().replace(awaitingApproval('w'))
    threads().close(firstId)
    openAll(idsFrom('t', MAX_OPEN_THREADS))
    expect(threads().order).toContain('w')
    expect(threads().order).not.toContain('t1')
  })
})

describe('useThreadStore openNew / close', () => {
  it('openNew reuses the thread in view when it is empty and idle', () => {
    const before = threads().activeId
    threads().openNew()
    expect(threads().activeId).toBe(before)
    expect(threads().order).toHaveLength(1)
  })

  it('openNew after a message brings a fresh empty idle thread into view', () => {
    const before = threads().activeId
    threads().dispatch({ type: 'local/user_message', message: USER_MESSAGE })
    threads().openNew()
    expect(threads().order).toStrictEqual([before, threads().activeId])
    expect(threads().thread.messages).toStrictEqual([])
    expect(threads().thread.status).toBe('idle')
  })

  it('openNew starts a fresh thread when the empty one in view awaits approval', () => {
    threads().replace(awaitingApproval('w'))
    threads().openNew()
    expect(threads().activeId).not.toBe('w')
    expect(threads().thread.status).toBe('idle')
  })

  it('close of a thread that is not open leaves the store untouched', () => {
    const before = threads()
    threads().close('missing')
    expect(threads()).toBe(before)
  })

  it('close of a background thread keeps the thread in view', () => {
    const firstId = threads().activeId
    openAll(['t1', 't2'])
    threads().activate(firstId)
    threads().close('t2')
    expect(threads().activeId).toBe(firstId)
    expect(threads().order).toStrictEqual([firstId, 't1'])
  })

  it('close of the thread in view falls back to the most recent other one', () => {
    openAll(['t1', 't2', 't3'])
    threads().activate('t2')
    threads().close('t2')
    expect(threads().activeId).toBe('t3')
  })

  it('close of the only thread opens a fresh one', () => {
    const only = threads().activeId
    threads().close(only)
    expect(threads().activeId).not.toBe(only)
    expect(threads().order).toStrictEqual([threads().activeId])
  })
})

describe('sign-out', () => {
  it('resets both stores and calls the sign-out listeners', () => {
    const listener = vi.fn()
    const unsubscribe = onAssistantSignOut(listener)
    useAuthStore.setState({ isAuthenticated: true })
    useAssistantUiStore.getState().setOpen(true)
    threads().replace(createThreadState('t1'))
    useAuthStore.setState({ isAuthenticated: false })
    unsubscribe()
    expect(listener).toHaveBeenCalledExactlyOnceWith()
    expect(useAssistantUiStore.getState().open).toBe(false)
    expect(threads().order).not.toContain('t1')
  })
  it('stops calling a listener once it unsubscribed', () => {
    const listener = vi.fn()
    onAssistantSignOut(listener)()
    useAuthStore.setState({ isAuthenticated: true })
    useAuthStore.setState({ isAuthenticated: false })
    expect(listener).not.toHaveBeenCalled()
  })

  it('does not reset on an auth update that keeps the user signed in', () => {
    useAuthStore.setState({ isAuthenticated: true })
    useAssistantUiStore.getState().setOpen(true)
    useAuthStore.setState({ isAuthenticated: true })
    expect(useAssistantUiStore.getState().open).toBe(true)
  })

  it('does not reset on an auth update while already signed out', () => {
    useAuthStore.setState({ isAuthenticated: false })
    useAssistantUiStore.getState().setOpen(true)
    useAuthStore.setState({ isAuthenticated: false })
    expect(useAssistantUiStore.getState().open).toBe(true)
  })
})
