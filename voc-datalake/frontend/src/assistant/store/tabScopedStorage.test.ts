/**
 * The assistant panel's open state is per tab (sessionStorage) while its
 * preferences stay shared (localStorage): opening the panel in one tab must not
 * open it in the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useAssistantUiStore } from './assistantStore'
import { tabScopedStorage } from './tabScopedStorage'

const KEY = 'voc-assistant-ui'

/** A Map-backed Web Storage (the global localStorage is a no-op mock in specs). */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() { return data.size },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()].at(index) ?? null,
    removeItem: (key) => { data.delete(key) },
    setItem: (key, value) => { data.set(key, value) },
  }
}

function stored(storage: Storage): unknown {
  const raw = storage.getItem(KEY)
  return raw === null ? null : JSON.parse(raw)
}

function envelope(state: Record<string, unknown>, version = 0): string {
  return JSON.stringify({ state, version })
}

describe('tabScopedStorage', () => {
  const shared = memoryStorage()
  const tab = memoryStorage()
  const storage = tabScopedStorage(['open'], { shared: () => shared, tab: () => tab })

  beforeEach(() => {
    shared.clear()
    tab.clear()
  })

  it('writes the per-tab field to the tab storage and the rest to the shared one', () => {
    storage.setItem(KEY, envelope({ open: true, mode: 'expanded' }))
    expect(stored(tab)).toStrictEqual({ state: { open: true }, version: 0 })
    expect(stored(shared)).toStrictEqual({ state: { mode: 'expanded' }, version: 0 })
  })

  it('reads the two halves back as one record', () => {
    storage.setItem(KEY, envelope({ open: true, mode: 'fullscreen' }, 2))
    expect(JSON.parse(storage.getItem(KEY) ?? 'null')).toStrictEqual({ state: { mode: 'fullscreen', open: true }, version: 2 })
  })

  it('ignores a per-tab field left in the shared storage by an older build or another tab', () => {
    shared.setItem(KEY, envelope({ open: true, mode: 'expanded' }))
    expect(JSON.parse(storage.getItem(KEY) ?? 'null')).toStrictEqual({ state: { mode: 'expanded' }, version: 0 })
  })

  it('answers null when neither storage holds the key, and for a malformed record', () => {
    expect(storage.getItem(KEY)).toBeNull()
    shared.setItem(KEY, '{not json')
    expect(storage.getItem(KEY)).toBeNull()
  })

  it('removes both halves', () => {
    storage.setItem(KEY, envelope({ open: true, mode: 'bubble' }))
    storage.removeItem(KEY)
    expect([shared.getItem(KEY), tab.getItem(KEY)]).toStrictEqual([null, null])
  })

  it('keeps the shared half when the tab storage is unavailable or throws on write', () => {
    const throwing: Storage = Object.assign(memoryStorage(), { setItem: () => { throw new Error('QuotaExceededError') } })
    const unavailable = tabScopedStorage(['open'], { shared: () => shared, tab: () => { throw new Error('SecurityError') } })
    tabScopedStorage(['open'], { shared: () => shared, tab: () => throwing }).setItem(KEY, envelope({ open: true, mode: 'expanded' }))
    expect(stored(shared)).toStrictEqual({ state: { mode: 'expanded' }, version: 0 })
    expect(unavailable.getItem(KEY)).toBe(envelope({ mode: 'expanded' }))
  })
})

describe('useAssistantUiStore open state', () => {
  beforeEach(() => {
    sessionStorage.clear()
    vi.mocked(localStorage.setItem).mockClear()
    vi.mocked(localStorage.getItem).mockReturnValue(null)
  })

  it('opening the panel stores open in this tab only', () => {
    useAssistantUiStore.getState().setOpen(true)
    // spyOn returns the setup file's existing mock (src/test/setup.ts), without detaching the method.
    const [, sharedWrite = ''] = vi.spyOn(localStorage, 'setItem').mock.lastCall ?? []
    expect(stored(sessionStorage)).toMatchObject({ state: { open: true } })
    expect(JSON.parse(sharedWrite)).not.toHaveProperty('state.open')
  })

  it('a fresh tab (empty sessionStorage) starts closed but keeps the shared mode', async () => {
    useAssistantUiStore.setState({ open: false, mode: 'bubble' })
    vi.mocked(localStorage.getItem).mockReturnValue(envelope({ open: true, mode: 'expanded' }))
    await useAssistantUiStore.persist.rehydrate()
    expect(useAssistantUiStore.getState()).toMatchObject({ open: false, mode: 'expanded' })
  })

  it('a reload of the same tab keeps the panel open', async () => {
    useAssistantUiStore.setState({ open: false })
    sessionStorage.setItem(KEY, envelope({ open: true }))
    await useAssistantUiStore.persist.rehydrate()
    expect(useAssistantUiStore.getState().open).toBe(true)
  })
})
