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
import { cleanup, render, screen } from '@testing-library/react'
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

/**
 * A dialog whose content is an `<iframe>` — the prototype enlarge overlay (#314).
 *
 * A keydown raised inside a frame's own document does NOT reach the embedder, so a
 * listener on this page's document alone stops seeing keys the moment focus enters
 * the frame. The frame is also in `focusable()`'s selector list, so a single Tab
 * puts it there. For an overlay whose entire purpose is that a reviewer clicks into
 * the artifact and navigates it, that is the DOMINANT state, not an edge case:
 * without the per-frame listeners, Escape and the Tab trap are inert for almost all
 * of the dialog's useful life.
 *
 * The keys below are dispatched on the frame's own document, which is what a
 * browser does and what `user.keyboard` cannot do — it targets the top document,
 * i.e. the pre-iframe state only.
 */
describe('ModalShell with a nested frame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * The shell with an `<iframe>` between two panel controls, its document filled
   * with `inner` controls.
   *
   * No `src`: jsdom gives a src-less frame a real about:blank document with a body,
   * where one loading over the network has `contentDocument` but no `body` — the
   * frame is a stand-in for a LOADED prototype, which is the state under test.
   */
  function renderFramedShell() {
    render(
      <ModalShell isOpen onClose={onClose} ariaLabel="Framed dialog">
        <button>close</button>
        <iframe title="prototype" />
        <button>after</button>
      </ModalShell>,
    )
    const frame = screen.getByTitle('prototype')
    const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null
    if (!doc?.body) throw new Error('no frame document to write the prototype into')
    doc.body.innerHTML = '<button id="inner-first">inner one</button><button id="inner-last">inner two</button>'
    /** Raise a key in the FRAME's document, as a browser does for a key pressed inside it. */
    const pressInFrame = (key: string, shiftKey = false) => {
      const target = doc.activeElement ?? doc.body
      target.dispatchEvent(
        new (doc.defaultView ?? window).KeyboardEvent('keydown', { key, shiftKey, bubbles: true }),
      )
    }
    return { doc, frame, pressInFrame }
  }

  it('closes on Escape pressed inside the frame', () => {
    // Without the frame listener this is silent: the reviewer is inside the
    // artifact, which is where the overlay is meant to be used, and the documented
    // way out does nothing.
    const { doc, pressInFrame } = renderFramedShell()
    doc.getElementById('inner-first')?.focus()

    pressInFrame('Escape')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('leaves Tab alone while it still has somewhere to go inside the frame', () => {
    // The trap must not fire on every Tab: a prototype is a page of its own, and
    // yanking a reviewer out of it at the first control would make the overlay
    // unusable for the thing it exists for.
    const { doc, pressInFrame } = renderFramedShell()
    const innerFirst = doc.getElementById('inner-first')
    innerFirst?.focus()

    pressInFrame('Tab')

    expect(doc.activeElement).toBe(innerFirst)
    expect(screen.getByRole('button', { name: 'after' })).not.toHaveFocus()
  })

  it('brings Tab back into the panel from the frame\'s last control', () => {
    // Where a browser would hand focus to whatever follows the frame — the page
    // BEHIND the overlay, which for this consumer is a second copy of the same
    // interactive prototype.
    const { doc, pressInFrame } = renderFramedShell()
    doc.getElementById('inner-last')?.focus()

    pressInFrame('Tab')

    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
  })

  it('brings shift-Tab back into the panel from the frame\'s first control', () => {
    const { doc, pressInFrame } = renderFramedShell()
    doc.getElementById('inner-first')?.focus()

    pressInFrame('Tab', true)

    expect(screen.getByRole('button', { name: 'close' })).toHaveFocus()
  })

  it('listens to a frame that arrives after the dialog is already open', async () => {
    // The overlay's frame does not exist on the shell's first commit in every
    // consumer: content can arrive with a query. A one-shot scan at mount would
    // cover the prototype overlay and quietly miss those.
    const user = userEvent.setup()
    function Late() {
      const [shown, setShown] = React.useState(false)
      return (
        <ModalShell isOpen onClose={onClose} ariaLabel="Late dialog">
          <button onClick={() => setShown(true)}>load</button>
          {shown ? <iframe title="late" /> : null}
        </ModalShell>
      )
    }
    render(<Late />)
    await user.click(screen.getByRole('button', { name: 'load' }))
    const frame = screen.getByTitle('late')
    const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null
    if (!doc?.body) throw new Error('no late frame document')

    doc.body.dispatchEvent(
      new (doc.defaultView ?? window).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes only the top-most dialog for Escape raised inside a frame', () => {
    // The stacking guard is document-position based and must keep working for a key
    // that arrived through a frame: `ConfirmModal` opens over other modals, and one
    // Escape closing both is the defect that guard exists for.
    const onCloseOuter = vi.fn()
    const onCloseInner = vi.fn()
    render(
      <>
        <ModalShell isOpen onClose={onCloseOuter} ariaLabel="Outer">
          <button>outer-button</button>
        </ModalShell>
        <ModalShell isOpen onClose={onCloseInner} ariaLabel="Inner">
          <iframe title="inner-frame" />
        </ModalShell>
      </>,
    )
    const frame = screen.getByTitle('inner-frame')
    const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null
    if (!doc?.body) throw new Error('no inner frame document')

    doc.body.dispatchEvent(
      new (doc.defaultView ?? window).KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    )

    expect(onCloseInner).toHaveBeenCalledTimes(1)
    expect(onCloseOuter).not.toHaveBeenCalled()
  })

  it('detaches the frame\'s listener when the dialog closes', () => {
    // The listener lives on a document this shell does not own. Leaking it is not
    // caught by dispatching a key afterwards — the top-most guard makes a leaked
    // listener inert, so the only observable is the detach itself, and a page with
    // one of these per row would otherwise accumulate one per open.
    const { doc } = renderFramedShell()
    const removals: unknown[] = []
    const realRemove = doc.removeEventListener.bind(doc)
    doc.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      removals.push(type)
      realRemove(type, listener, options)
    }

    cleanup()

    expect(removals).toContain('keydown')
  })
})
