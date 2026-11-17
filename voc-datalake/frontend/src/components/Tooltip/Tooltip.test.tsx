/**
 * Tooltip (docs/kiro-design-system.md › Tooltips): the roles and ARIA of both kinds, hover after 80 ms, keyboard
 * focus at once, Escape that closes only the tooltip, no focus trap, one tooltip at a time, touch, and the
 * trigger's own handlers and ref kept.
 *
 * Events are fired directly (user-event's async wrapper waits on a timer the fake clock never runs). The fake
 * clock is installed once and only moves forward: the delay group remembers when the last tooltip closed.
 */
import { act, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { Tooltip } from './Tooltip'
import { OPEN_DELAY_MS, SKIP_DELAY_MS } from './tooltipTiming'

const advance = (ms: number) => act(() => {
  vi.advanceTimersByTime(ms)
})
const hover = (element: Element, pointerType = 'mouse') => fireEvent.pointerOver(element, { pointerType })
/** Keyboard focus: jsdom matches `:focus-visible` on a scripted focus only after a key press. */
const focus = (element: HTMLElement) => {
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Tab' })
  act(() => {
    element.focus()
  })
}
const escape = () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' })

function Buttons() {
  return (
    <div>
      <Tooltip kind="label" content="Delete">
        <button type="button" aria-label="Delete">x</button>
      </Tooltip>
      <Tooltip kind="description" content="Changed by Ana on 3 May">
        <button type="button">Edit</button>
      </Tooltip>
      <button type="button">Next</button>
    </div>
  )
}

const deleteButton = () => screen.getByRole('button', { name: 'Delete' })
const editButton = () => screen.getByRole('button', { name: 'Edit' })

beforeAll(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  escape()
  advance(SKIP_DELAY_MS * 2)
})

afterAll(() => {
  vi.useRealTimers()
})

describe('kind="label"', () => {
  it('opens 80 ms after a mouse rests on the trigger, hidden from assistive technology', () => {
    render(<Buttons />)
    hover(deleteButton())
    advance(OPEN_DELAY_MS - 1)
    expect(screen.queryByText('Delete')).toBeNull()
    advance(1)
    expect(screen.getByText('Delete')).toHaveAttribute('role', 'tooltip')
    expect(screen.getByText('Delete')).toHaveAttribute('aria-hidden', 'true')
    expect(deleteButton()).not.toHaveAttribute('aria-describedby')
  })

  it('opens at once on keyboard focus and closes on Escape without moving focus', () => {
    render(<Buttons />)
    focus(deleteButton())
    expect(screen.getByText('Delete')).toBeVisible()
    escape()
    expect(screen.queryByText('Delete')).toBeNull()
    expect(deleteButton()).toHaveFocus()
  })

  it('does not open on the focus a click brings', () => {
    render(<Buttons />)
    fireEvent.pointerDown(deleteButton(), { pointerType: 'mouse' })
    focus(deleteButton())
    advance(OPEN_DELAY_MS * 2)
    expect(screen.queryByText('Delete')).toBeNull()
  })

  it('does not open on the focus a dialog gives its first control (Enter opened it), so Escape reaches the dialog', () => {
    render(<Buttons />)
    fireEvent.keyDown(document.body, { key: 'Enter' })
    act(() => {
      deleteButton().focus()
    })
    expect(deleteButton()).toHaveFocus()
    expect(screen.queryByText('Delete')).toBeNull()
  })
})

describe('kind="description"', () => {
  it('describes the trigger through role="tooltip", shown or not', () => {
    render(<Buttons />)
    expect(editButton()).toHaveAccessibleDescription('Changed by Ana on 3 May')
    expect(screen.getByText('Changed by Ana on 3 May')).not.toBeVisible()
    hover(editButton())
    advance(OPEN_DELAY_MS)
    expect(screen.getByRole('tooltip')).toBeVisible()
  })

  it('traps no focus: the bubble takes none, and focus moving on closes it', () => {
    render(<Buttons />)
    focus(editButton())
    const tip = screen.getByRole('tooltip')
    expect(tip).not.toHaveAttribute('tabindex')
    focus(screen.getByRole('button', { name: 'Next' }))
    expect(screen.getByRole('button', { name: 'Next' })).toHaveFocus()
    expect(tip).not.toBeVisible()
  })
})

describe('Escape', () => {
  it('goes no further than an open tooltip, so the dialog under it stays', () => {
    const onEscape = vi.fn()
    render(<Buttons />)
    focus(deleteButton())
    document.addEventListener('keydown', onEscape)
    escape()
    expect(onEscape).not.toHaveBeenCalled()
    escape()
    expect(onEscape).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', onEscape)
  })

  it('closes the tooltip of a text field and still reaches the field (an inline rename cancels on it)', () => {
    const onFieldEscape = vi.fn()
    render(
      <Tooltip kind="description" content="Enter saves">
        <input aria-label="Name" onKeyDown={(event) => { if (event.key === 'Escape') onFieldEscape() }} />
      </Tooltip>,
    )
    const field = screen.getByRole('textbox', { name: 'Name' })
    focus(field)
    expect(screen.getByRole('tooltip')).toBeVisible()
    fireEvent.keyDown(field, { key: 'Escape' })
    expect(onFieldEscape).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('tooltip', { hidden: true })).not.toBeVisible()
  })
})

describe('one at a time', () => {
  it('opens the next tooltip at once (the delay group) and closes the first', () => {
    render(<Buttons />)
    hover(deleteButton())
    advance(OPEN_DELAY_MS)
    fireEvent.pointerOut(deleteButton(), { pointerType: 'mouse' })
    hover(editButton())
    expect(screen.getByText('Changed by Ana on 3 May')).toBeVisible()
    expect(screen.queryByText('Delete')).toBeNull()
  })
})

describe('the trigger', () => {
  it('keeps its own handlers and ref, and an empty content opens nothing', () => {
    const onFocus = vi.fn()
    const ref = createRef<HTMLButtonElement>()
    render(
      <Tooltip kind="description" content={undefined}>
        <button ref={ref} type="button" aria-label="Run" onFocus={onFocus}>r</button>
      </Tooltip>,
    )
    focus(screen.getByRole('button', { name: 'Run' }))
    expect(onFocus).toHaveBeenCalledTimes(1)
    expect(ref.current).toBe(screen.getByRole('button', { name: 'Run' }))
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  })

  it('does not open on touch: a tap performs the action', () => {
    const onClick = vi.fn()
    render(
      <Tooltip kind="label" content="Run">
        <button type="button" aria-label="Run" onClick={onClick}>r</button>
      </Tooltip>,
    )
    const button = screen.getByRole('button', { name: 'Run' })
    hover(button, 'touch')
    fireEvent.pointerDown(button, { pointerType: 'touch' })
    fireEvent.click(button)
    advance(OPEN_DELAY_MS * 2)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('tooltip', { hidden: true })).toBeNull()
  })

  it('keeps a click inside the bubble from reaching the row the trigger sits in', () => {
    const onRowClick = vi.fn()
    render(
      <div onClick={onRowClick}>
        <Tooltip kind="label" content="Pin">
          <button type="button" aria-label="Pin">p</button>
        </Tooltip>
      </div>,
    )
    hover(screen.getByRole('button', { name: 'Pin' }))
    advance(OPEN_DELAY_MS)
    fireEvent.click(screen.getByText('Pin'))
    expect(onRowClick).not.toHaveBeenCalled()
  })
})
