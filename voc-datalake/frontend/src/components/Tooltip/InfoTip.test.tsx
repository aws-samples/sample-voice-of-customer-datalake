/**
 * InfoTip: the ⓘ glyph's name and description, hover and keyboard focus like a Tooltip, and the pin of a
 * click or tap, which a second click, a press outside, Escape or blur undo.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { InfoTip } from './InfoTip'
import { CLOSE_DELAY_MS, OPEN_DELAY_MS, SKIP_DELAY_MS } from './tooltipTiming'

const TEXT = 'Synthetic reviews are written by the model, not by customers.'

const advance = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms)
})
const glyph = () => screen.getByRole('button', { name: 'More information' })
/** A click or tap: the press, then the click. */
const tap = (element: Element, pointerType = 'mouse') => {
  fireEvent.pointerDown(element, { pointerType })
  fireEvent.click(element)
}

beforeAll(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  fireEvent.keyDown(document.body, { key: 'Escape' })
  advance(SKIP_DELAY_MS * 2)
})

afterAll(() => {
  vi.useRealTimers()
})

describe('InfoTip', () => {
  it('is a named glyph described by its text, shown or not', () => {
    render(<InfoTip text={TEXT} />)
    expect(glyph()).toHaveAccessibleDescription(TEXT)
    expect(screen.getByText(TEXT)).not.toBeVisible()
  })

  it('shows on hover after the delay and on keyboard focus at once', () => {
    render(<InfoTip text={TEXT} />)
    fireEvent.pointerOver(glyph(), { pointerType: 'mouse' })
    advance(OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).toHaveTextContent(TEXT)
    fireEvent.pointerOut(glyph(), { pointerType: 'mouse' })
    advance(CLOSE_DELAY_MS)
    expect(screen.getByText(TEXT)).not.toBeVisible()
  })

  it('pins open on a tap and stays when the pointer leaves, until the next tap', () => {
    render(<InfoTip text={TEXT} />)
    tap(glyph(), 'touch')
    fireEvent.pointerOut(glyph(), { pointerType: 'touch' })
    advance(CLOSE_DELAY_MS * 3)
    expect(screen.getByRole('tooltip')).toBeVisible()
    tap(glyph(), 'touch')
    expect(screen.getByText(TEXT)).not.toBeVisible()
  })

  it('unpins on a press outside, but not on one inside the bubble', () => {
    render(<><InfoTip text={TEXT} /><p>Elsewhere</p></>)
    tap(glyph())
    fireEvent.pointerDown(screen.getByRole('tooltip'))
    expect(screen.getByRole('tooltip')).toBeVisible()
    fireEvent.pointerDown(screen.getByText('Elsewhere'))
    expect(screen.getByText(TEXT)).not.toBeVisible()
  })
})
