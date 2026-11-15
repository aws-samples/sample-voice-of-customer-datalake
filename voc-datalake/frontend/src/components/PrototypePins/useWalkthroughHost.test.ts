/**
 * The host hook's own state (docs/prototype-builder.md Part 1): the editor's preview plays unsaved steps and its
 * "don't show again" sets no flag; a pick asks the frame and ends with the element (a new seq each time) or with
 * nothing when cancelled; done and skipped end a preview.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useWalkthroughHost } from './useWalkthroughHost'
import type { WalkthroughMessage } from './walkthroughMessages'

const SCOPE = { person: 'sub-rui', projectId: 'p1', seriesKey: 'checkout', documentId: 'proto_2' }
const STEP = { title: 'Order', body: 'Its date.', selector: '#order' }
const ANCHOR = { route: '', bbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.2 } }
const TYPE = 'voc-walkthrough' as const

function hostWithPort() {
  const { port1 } = new MessageChannel()
  const sent = vi.spyOn(port1, 'postMessage')
  const { result } = renderHook(() => useWalkthroughHost(SCOPE))
  const tell = (message: WalkthroughMessage) => { act(() => { result.current.onMessage(message, port1) }) }
  // A version without steps: ready hands the port over and starts nothing.
  tell({ type: TYPE, event: 'ready', steps: 0 })
  return { result, sent, tell }
}

afterEach(() => {
  vi.spyOn(window.localStorage, 'setItem').mockReset()
})

describe('useWalkthroughHost', () => {
  it('previews unsaved steps from a step, and that preview\'s "don\'t show again" sets no flag', () => {
    const setItem = vi.spyOn(window.localStorage, 'setItem')
    const { result, sent, tell } = hostWithPort()
    act(() => { result.current.preview([STEP], 0) })
    tell({ type: TYPE, event: 'dont-show-again' })

    expect(sent).toHaveBeenCalledWith({ type: TYPE, action: 'start', step: 0, steps: [STEP] })
    expect([result.current.runtime, result.current.steps, setItem.mock.calls]).toStrictEqual([true, 0, []])
  })

  it('a pick asks the frame, then holds the element with a new seq each time', () => {
    const { result, sent, tell } = hostWithPort()
    act(() => { result.current.pick() })
    expect([result.current.picking, sent.mock.calls]).toStrictEqual([true, [[{ type: TYPE, action: 'pick' }]]])

    tell({ type: TYPE, event: 'picked', selector: '#order', anchor: ANCHOR })
    tell({ type: TYPE, event: 'picked', anchor: ANCHOR })
    expect([result.current.picking, result.current.picked]).toStrictEqual([false, { seq: 2, selector: undefined, anchor: ANCHOR }])
  })

  it('a cancelled pick ends picking with nothing picked; done and skipped change nothing else', () => {
    const { result, tell } = hostWithPort()
    act(() => { result.current.pick() })
    tell({ type: TYPE, event: 'pick-cancelled' })
    tell({ type: TYPE, event: 'done' })
    tell({ type: TYPE, event: 'skipped' })

    expect([result.current.picking, result.current.picked]).toStrictEqual([false, null])
  })
})
