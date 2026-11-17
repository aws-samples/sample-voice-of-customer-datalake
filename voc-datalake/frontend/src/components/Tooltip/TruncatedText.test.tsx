/**
 * TruncatedText: the whole text in a tooltip only while it is cut, and the element it renders. jsdom lays
 * nothing out, so the cut is stubbed through the element's scroll and client widths.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { TruncatedText } from './TruncatedText'
import { OPEN_DELAY_MS, SKIP_DELAY_MS } from './tooltipTiming'

const NAME = 'Quarterly churn interviews, enterprise segment, EMEA'

const advance = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms)
})

function stubWidths(element: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(element, 'scrollWidth', { configurable: true, value: scrollWidth })
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: clientWidth })
}

function hoverName(): void {
  fireEvent.pointerOver(screen.getByText(NAME), { pointerType: 'mouse' })
  advance(OPEN_DELAY_MS)
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

describe('TruncatedText', () => {
  it('renders the text in the element and class asked for', () => {
    render(<TruncatedText as="p" className="truncate font-medium" text={NAME} />)
    const text = screen.getByText(NAME)
    expect(text.tagName).toBe('P')
    expect(text).toHaveClass('truncate', 'font-medium')
  })

  it('shows the whole text in a hidden-from-AT tooltip when the text is cut', () => {
    render(<TruncatedText className="truncate" text={NAME} />)
    stubWidths(screen.getByText(NAME), 400, 120)
    hoverName()
    const tip = screen.getByRole('tooltip', { hidden: true })
    expect(tip).toHaveTextContent(NAME)
    expect(tip).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows nothing when the text fits', () => {
    render(<TruncatedText className="truncate" text={NAME} />)
    stubWidths(screen.getByText(NAME), 120, 120)
    hoverName()
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  })
})
