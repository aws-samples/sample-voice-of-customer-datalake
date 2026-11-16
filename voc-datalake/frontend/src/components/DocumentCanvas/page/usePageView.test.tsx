/**
 * The page's view switches as the person's stored preferences: without a stored choice the comments panel is closed,
 * Contents shown and the full width on; a stored choice is kept (version 1, the first stored shape: nothing earlier to
 * migrate); a record that is not one costs only its own fields; only an explicit switch stores a choice, while
 * `revealComments` opens the panel for this visit only (the next page shows the stored choice); a document without
 * comments has no panel switch.
 */
import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parsedJson } from '@test/jsonText'
import { asRecord } from '../../../api/wireRecord'
import { usePageView, useDocumentViewStore } from './usePageView'

const STORE = 'voc-document-view'

/** What the hook shows, as one value. */
function switches(view: ReturnType<typeof usePageView>) {
  return { comments: view.comments?.on, outline: view.outline.on, fullWidth: view.fullWidth.on }
}

/** The store as a browser with this record (null: none) would load it. */
async function loadFrom(record: unknown) {
  const { persist } = useDocumentViewStore
  const options = persist.getOptions()
  useDocumentViewStore.setState({ comments: false, outline: true, fullWidth: true })
  persist.setOptions({
    storage: {
      getItem: () => (record === null ? null : { state: record, version: 1 }),
      setItem: () => { /* not written in these specs */ },
      removeItem: () => { /* nothing to remove */ },
    },
  })
  await persist.rehydrate()
  persist.setOptions(options)
}

beforeEach(() => {
  useDocumentViewStore.setState({ comments: false, outline: true, fullWidth: true })
})

describe('usePageView', () => {
  it('starts with the comments panel closed, Contents shown and the full width on', async () => {
    await loadFrom(null)
    const { result } = renderHook(() => usePageView(true))
    expect(switches(result.current)).toStrictEqual({ comments: false, outline: true, fullWidth: true })
  })

  it('keeps a stored choice, and stores the next one under its own name, version 1', async () => {
    await loadFrom({ comments: true, outline: false, fullWidth: false })
    const { result } = renderHook(() => usePageView(true))
    expect(switches(result.current)).toStrictEqual({ comments: true, outline: false, fullWidth: false })
    act(() => { result.current.fullWidth.toggle() })
    expect(result.current.fullWidth.on).toBe(true)
    expect(useDocumentViewStore.persist.getOptions()).toMatchObject({ name: STORE, version: 1 })
  })

  it('reads a record that is not one field by field: what it holds wrong is the default', async () => {
    await loadFrom({ comments: 'yes', outline: false })
    const { result } = renderHook(() => usePageView(true))
    expect(switches(result.current)).toStrictEqual({ comments: false, outline: false, fullWidth: true })
  })

  /** What this browser was asked to keep of the view (its last write), or null: nothing written. */
  const written = () => {
    const writes = vi.mocked(localStorage.setItem).mock.calls.filter(([key]) => key === STORE)
    const last = writes.at(-1)?.[1]
    return last === undefined ? null : asRecord(parsedJson(last))?.state
  }

  it('opens the panel for what needs it for this visit only: nothing is stored, the next page shows the stored choice', () => {
    vi.mocked(localStorage.setItem).mockClear()
    const { result, unmount } = renderHook(() => usePageView(true))
    act(() => { result.current.revealComments() })
    expect([result.current.comments?.on, useDocumentViewStore.getState().comments, written()]).toStrictEqual([true, false, null])
    unmount()
    const next = renderHook(() => usePageView(true))
    expect(next.result.current.comments?.on).toBe(false)
  })

  it('stores an explicit switch: opening, and closing a panel that opened by itself', () => {
    vi.mocked(localStorage.setItem).mockClear()
    const { result } = renderHook(() => usePageView(true))
    act(() => { result.current.comments?.toggle() })
    expect([result.current.comments?.on, written()]).toStrictEqual([true, { comments: true, outline: true, fullWidth: true }])
    act(() => { result.current.comments?.toggle() })
    act(() => { result.current.revealComments() })
    act(() => { result.current.comments?.toggle() })
    expect([result.current.comments?.on, written()]).toStrictEqual([false, { comments: false, outline: true, fullWidth: true }])
    act(() => { result.current.outline.toggle() })
    expect(written()).toStrictEqual({ comments: false, outline: false, fullWidth: true })
  })

  it('has no panel switch for a document without comments', () => {
    const { result } = renderHook(() => usePageView(false))
    expect(result.current.comments).toBeUndefined()
  })
})
