/**
 * Tests for the shared modal shell (issue #283).
 *
 * These pin the behaviours the shell exists to guarantee, so that adopting it in
 * a modal is enough to get them — the audit found 21 of 23 modal surfaces missing
 * dialog semantics and 20 missing Escape, precisely because each one had to
 * remember them independently.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ModalShell from './ModalShell'

const onClose = vi.fn()

/**
 * Overridable props exclude the accessible-name pair on purpose. The name is a
 * union (exactly one of ariaLabel / ariaLabelledBy), and `Partial<>` of a union
 * makes both optional — which would let a spread satisfy neither arm and defeat
 * the very guarantee these tests pin. Tests needing a different naming strategy
 * render ModalShell directly, as the ariaLabelledBy cases below do.
 */
type ShellOverrides = Partial<
  Omit<React.ComponentProps<typeof ModalShell>, 'ariaLabel' | 'ariaLabelledBy'>
>

function renderShell(props: ShellOverrides = {}) {
  return render(
    <ModalShell isOpen onClose={onClose} ariaLabel="Test dialog" {...props}>
      <button>first</button>
      <button>last</button>
    </ModalShell>,
  )
}

describe('ModalShell', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders nothing when closed', () => {
    renderShell({ isOpen: false })

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('exposes the panel as a modal dialog with an accessible name', () => {
    renderShell()

    const dialog = screen.getByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveAccessibleName('Test dialog')
  })

  it('closes when Escape is pressed', async () => {
    const user = userEvent.setup()
    renderShell()

    await user.keyboard('{Escape}')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes when the overlay is clicked', async () => {
    const user = userEvent.setup()
    renderShell()

    const overlay = screen.getByTestId('modal-overlay')
    expect(overlay).not.toBeNull()
    await user.click(overlay as Element)

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('does not close when the panel is clicked', async () => {
    // The load-bearing negative: it pins the sibling-overlay layering against
    // being refactored back into one fused element, which is what made overlay
    // clicks impossible before #281.
    const user = userEvent.setup()
    renderShell()

    await user.click(screen.getByRole('dialog'))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('ignores Escape and overlay clicks when not dismissable', async () => {
    const user = userEvent.setup()
    renderShell({ dismissable: false })

    await user.keyboard('{Escape}')
    await user.click(screen.getByTestId('modal-overlay') as Element)

    expect(onClose).not.toHaveBeenCalled()
  })

  it('moves focus into the dialog when opened', () => {
    renderShell()

    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus()
  })

  it('skips hidden controls when choosing where to put focus', () => {
    // A modal with collapsible sections would otherwise focus an invisible
    // control, leaving the user with no visible focus ring.
    render(
      <ModalShell isOpen onClose={onClose} ariaLabel="Test dialog">
        <button style={{ display: 'none' }}>hidden</button>
        <button>visible</button>
      </ModalShell>,
    )

    expect(screen.getByRole('button', { name: 'visible' })).toHaveFocus()
  })

  it('skips controls inside a hidden container, not just hidden controls', () => {
    // The real collapsible-section shape: the CONTAINER is hidden, and computed
    // display of a child inside it is the child's own value — so checking only
    // the element misses this. Requires walking ancestors.
    render(
      <ModalShell isOpen onClose={onClose} ariaLabel="Test dialog">
        <div style={{ display: 'none' }}>
          <button>collapsed</button>
        </div>
        <button>visible</button>
      </ModalShell>,
    )

    expect(screen.getByRole('button', { name: 'visible' })).toHaveFocus()
  })

  it('restores focus to the triggering element when closed', async () => {
    const user = userEvent.setup()
    function Harness() {
      const [open, setOpen] = React.useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>open</button>
          <ModalShell isOpen={open} onClose={() => setOpen(false)} ariaLabel="Test dialog">
            <button onClick={() => setOpen(false)}>close</button>
          </ModalShell>
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'open' })
    await user.click(trigger)

    await user.click(screen.getByRole('button', { name: 'close' }))

    expect(trigger).toHaveFocus()
  })

  it('wraps shift-Tab from the first focusable back to the last', async () => {
    const user = userEvent.setup()
    renderShell()
    const first = screen.getByRole('button', { name: 'first' })
    const last = screen.getByRole('button', { name: 'last' })

    first.focus()
    await user.tab({ shift: true })

    expect(last).toHaveFocus()
  })

  it('closes the top-most dialog on Escape even when focus is on the body', async () => {
    // THE regression this guard exists for. The previous focus-based guard died
    // silently here — and focus lands on <body> in ordinary flows, e.g. when the
    // focused control is removed or disabled. Passing requires the stack/document
    // -order guard, not a focus check.
    const user = userEvent.setup()
    const onCloseOuter = vi.fn()
    const onCloseInner = vi.fn()
    render(
      <>
        <ModalShell isOpen onClose={onCloseOuter} ariaLabel="Outer">
          <button>outer-button</button>
        </ModalShell>
        <ModalShell isOpen onClose={onCloseInner} ariaLabel="Inner">
          <button>inner-button</button>
        </ModalShell>
      </>,
    )
    // Simulate focus being dropped to the body, as browsers do.
    ;(document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur()
    expect(document.activeElement).toBe(document.body)

    await user.keyboard('{Escape}')

    expect(onCloseInner).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })

  it('closes the inner dialog when a nested shell is already open on first commit', async () => {
    // The bug the document-order guard fixes. React runs CHILD effects before
    // PARENT effects, so registration order here is [inner, outer] and a
    // "last registered wins" guard would close the OUTER dialog. Sibling shells
    // cannot catch this: there, registration and document order agree.
    const user = userEvent.setup()
    const onCloseOuter = vi.fn()
    const onCloseInner = vi.fn()
    render(
      <ModalShell isOpen onClose={onCloseOuter} ariaLabel="Outer">
        <button>outer-button</button>
        <ModalShell isOpen onClose={onCloseInner} ariaLabel="Inner">
          <button>inner-button</button>
        </ModalShell>
      </ModalShell>,
    )

    // Documents a consequence of the same effect ordering: the CHILD's focus
    // effect runs first, then the PARENT's overwrites it, so focus lands outside
    // the top-most dialog. Escape still works because the guard is document-order
    // based, not focus based — but stage 2 introduces genuinely nested wizards and
    // will need to decide whether the inner dialog should keep focus.
    expect(screen.getByRole('button', { name: 'outer-button' })).toHaveFocus()

    await user.keyboard('{Escape}')

    expect(onCloseInner).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })

  it('closes only the top-most dialog on Escape when shells are stacked', async () => {
    // ConfirmModal is used as an unsaved-changes guard inside other modals, so
    // shells nest. An unguarded document listener would close both on one press.
    const user = userEvent.setup()
    const onCloseOuter = vi.fn()
    const onCloseInner = vi.fn()
    render(
      <>
        <ModalShell isOpen onClose={onCloseOuter} ariaLabel="Outer">
          <button>outer-button</button>
        </ModalShell>
        <ModalShell isOpen onClose={onCloseInner} ariaLabel="Inner">
          <button>inner-button</button>
        </ModalShell>
      </>,
    )
    screen.getByRole('button', { name: 'inner-button' }).focus()

    await user.keyboard('{Escape}')

    expect(onCloseInner).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })

  it('does not trap Tab for a dialog that is not top-most', async () => {
    const user = userEvent.setup()
    render(
      <>
        <ModalShell isOpen onClose={vi.fn()} ariaLabel="Outer">
          <button>outer-first</button>
          <button>outer-last</button>
        </ModalShell>
        <ModalShell isOpen onClose={vi.fn()} ariaLabel="Inner">
          <button>inner-only</button>
        </ModalShell>
      </>,
    )
    const inner = screen.getByRole('button', { name: 'inner-only' })
    inner.focus()

    // Sole focusable in the focused dialog ⇒ Tab wraps to itself, and must not
    // hand focus to the other shell's panel.
    await user.tab()

    expect(inner).toHaveFocus()
  })

  it('wraps Tab from the last focusable back to the first', async () => {
    const user = userEvent.setup()
    renderShell()
    const first = screen.getByRole('button', { name: 'first' })
    const last = screen.getByRole('button', { name: 'last' })

    last.focus()
    await user.tab()

    expect(first).toHaveFocus()
  })
})
