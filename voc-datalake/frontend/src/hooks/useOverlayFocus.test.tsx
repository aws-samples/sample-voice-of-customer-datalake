/**
 * useOverlayFocus: the keyboard contract of a non-modal overlay (design audit
 * qa/design D-OVL): focus moves in on open, Escape closes and returns focus to
 * the trigger, Tab leaving a menu closes it, and a click elsewhere keeps the
 * focus the user chose.
 */
import { useRef, useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useOverlayFocus } from './useOverlayFocus'

function Harness({ closeOnFocusOut = false, initialFocus }: Readonly<{ closeOnFocusOut?: boolean; initialFocus?: string }>) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useOverlayFocus(ref, open, { onClose: () => setOpen(false), closeOnFocusOut, initialFocus })
  return (
    <div>
      <button type="button" onClick={() => setOpen((v) => !v)}>Trigger</button>
      {open && (
        <div ref={ref} role="menu" aria-label="Popup">
          <button type="button" role="menuitem">First</button>
          <button type="button" role="menuitem" data-selected="true">Second</button>
        </div>
      )}
      <button type="button">After</button>
    </div>
  )
}

describe('useOverlayFocus', () => {
  it('moves focus to the first item when the overlay opens', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Trigger' }))
    expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus()
  })

  it('honours initialFocus (e.g. the selected option)', async () => {
    render(<Harness initialFocus='[data-selected="true"]' />)
    await userEvent.click(screen.getByRole('button', { name: 'Trigger' }))
    expect(screen.getByRole('menuitem', { name: 'Second' })).toHaveFocus()
  })

  it('closes on Escape and puts focus back on the trigger', async () => {
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'Trigger' })
    trigger.focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.getByRole('menu')).toBeInTheDocument()
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(trigger).toHaveFocus()
  })

  it('closes when Tab leaves it, without pulling focus back', async () => {
    render(<Harness closeOnFocusOut />)
    await userEvent.click(screen.getByRole('button', { name: 'Trigger' }))
    await userEvent.tab()
    await userEvent.tab()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus()
  })

  it('stays open when Tab leaves it unless closeOnFocusOut is set', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Trigger' }))
    await userEvent.tab()
    await userEvent.tab()
    expect(screen.getByRole('menu')).toBeInTheDocument()
  })

  it('does not steal focus back when the overlay closes after a click elsewhere', async () => {
    render(<Harness />)
    await userEvent.click(screen.getByRole('button', { name: 'Trigger' }))
    const after = screen.getByRole('button', { name: 'After' })
    after.focus()
    await userEvent.click(screen.getByRole('button', { name: 'Trigger' }))
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Trigger' })).toHaveFocus()
  })
})

// The mobile drawer is `visibility: hidden` for the first frame(s) after it opens
// (the property is transitioned), so the first focus() is a no-op in a browser.
describe('useOverlayFocus while the overlay is still becoming visible', () => {
  it('retries on later frames until focus lands', async () => {
    const original = HTMLElement.prototype.focus
    const state = { refusals: 2 }
    const spy = vi.spyOn(HTMLElement.prototype, 'focus').mockImplementation(function (this: HTMLElement, options?: FocusOptions) {
      if (this.textContent === 'First' && state.refusals > 0) {
        state.refusals -= 1
        return
      }
      original.call(this, options)
    })
    try {
      render(<Harness />)
      await userEvent.click(screen.getByRole('button', { name: 'Trigger' }))
      await waitFor(() => expect(screen.getByRole('menuitem', { name: 'First' })).toHaveFocus())
      expect(state.refusals).toBe(0)
    } finally {
      spy.mockRestore()
    }
  })
})
