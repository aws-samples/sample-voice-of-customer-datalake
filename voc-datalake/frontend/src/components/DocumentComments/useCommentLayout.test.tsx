/**
 * The bubbles' ref callbacks: one per thread for good, so a detach and re-attach (StrictMode's mount, a re-render)
 * keeps the same callback, and React never churns the box through a new ref (unobserve / observe on every render).
 */
import { render, renderHook, screen } from '@testing-library/react'
import { StrictMode, createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCommentLayout } from './useCommentLayout'

const observed = vi.fn<(element: Element) => void>()

class CountingResizeObserver {
  observe(element: Element) { observed(element) }
  unobserve() { /* nothing to count */ }
  disconnect() { /* nothing to count */ }
}

afterEach(() => {
  vi.unstubAllGlobals()
  observed.mockReset()
})

/** Runs a ref callback's cleanup (React's detach), when it returned one. */
function detach(cleanup: void | (() => void)): void {
  if (typeof cleanup === 'function') cleanup()
}

const margin = createRef<HTMLElement>()
const noRoot = () => null

function Bubble({ tick }: Readonly<{ tick: number }>) {
  const layout = useCommentLayout(noRoot, margin, [], '', null)
  return <div ref={layout.bubbleRef('t1')} data-testid="bubble" data-tick={tick} />
}

describe('useCommentLayout: bubbleRef', () => {
  it('keeps one callback per thread across a detach and re-attach', () => {
    const { result, rerender } = renderHook(() => useCommentLayout(noRoot, margin, [], '', null))
    const first = result.current.bubbleRef('t1')

    detach(first(document.createElement('div')))
    rerender()

    expect(result.current.bubbleRef('t1')).toBe(first)
    expect(result.current.bubbleRef('t2')).not.toBe(first)
  })

  it('in StrictMode, observes the box on mount only: a re-render keeps its ref', () => {
    vi.stubGlobal('ResizeObserver', CountingResizeObserver)
    const { rerender } = render(<StrictMode><Bubble tick={0} /></StrictMode>)
    const box = screen.getByTestId('bubble')
    const onMount = observed.mock.calls.filter(([element]) => element === box).length

    rerender(<StrictMode><Bubble tick={1} /></StrictMode>)
    rerender(<StrictMode><Bubble tick={2} /></StrictMode>)

    expect(onMount).toBeGreaterThan(0)
    expect(observed.mock.calls.filter(([element]) => element === box)).toHaveLength(onMount)
  })
})
