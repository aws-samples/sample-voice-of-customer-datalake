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
/**
 * Record the keydown listeners added to, and removed from, every frame document any
 * code reads while the returned restore function has not been called.
 *
 * Installed by patching `contentDocument` rather than the documents themselves,
 * because a frame's document does not exist until the frame is inserted and the shell
 * attaches during that same synchronous insertion — there is no moment in between for
 * a test to hold. Reading `contentDocument` is how the shell finds a document at all
 * (`frameDocument()`), so wrapping the getter puts the spy in front of every attach
 * without changing which object anyone gets: the same document is returned, with its
 * own `addEventListener` / `removeEventListener` wrapped once.
 */
function spyOnFrameDocumentListeners(
  added: EventListenerOrEventListenerObject[],
  removed: EventListenerOrEventListenerObject[],
): () => void {
  const real = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentDocument')
  if (!real?.get) throw new Error('no contentDocument getter to wrap')
  const realGet = real.get
  const wrapped = new WeakSet<Document>()
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', {
    configurable: true,
    get(): Document | null {
      const doc: Document | null = realGet.call(this)
      if (doc && !wrapped.has(doc)) {
        wrapped.add(doc)
        const realAdd = doc.addEventListener.bind(doc)
        const realRemove = doc.removeEventListener.bind(doc)
        doc.addEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
          if (type === 'keydown') added.push(listener)
          realAdd(type, listener, options)
        }
        doc.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
          if (type === 'keydown') removed.push(listener)
          realRemove(type, listener, options)
        }
      }
      return doc
    },
  })
  return () => Object.defineProperty(HTMLIFrameElement.prototype, 'contentDocument', real)
}

describe('ModalShell with a nested frame', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  /**
   * The shell with an `<iframe>` among its panel controls, its document filled with
   * `inner` controls.
   *
   * No `src`: jsdom gives a src-less frame a real about:blank document with a body,
   * where one loading over the network has `contentDocument` but no `body` — the
   * frame is a stand-in for a LOADED prototype, which is the state under test.
   *
   * @param options.trailing whether a control FOLLOWS the frame in the panel.
   *   `true` (the default) is the shape the frame-exit tests need: only a following
   *   item can show that focus resumes AFTER the frame rather than at the panel's
   *   edge. `false` is the shape the only real consumer actually has —
   *   `PrototypeEnlargeButton`'s panel is `[Close, <iframe>]` — where the frame is
   *   the panel's LAST focusable and the parent-document Tab path behaves
   *   differently. Both geometries are covered because the easier one cannot fail on
   *   the harder one's behaviour.
   * @param options.leading whether a control PRECEDES the frame. `false` makes the
   *   frame the panel's first focusable, which is where the backwards wrap is
   *   observable.
   * @param options.inner the frame's own content, so a test can give the frame
   *   nothing focusable — the case where Tab must NOT be allowed to descend.
   */
  function renderFramedShell(
    {
      leading = true,
      trailing = true,
      inner = '<button id="inner-first">inner one</button><button id="inner-last">inner two</button>',
    } = {},
  ) {
    render(
      <ModalShell isOpen onClose={onClose} ariaLabel="Framed dialog">
        {leading ? <button>close</button> : null}
        <iframe title="prototype" />
        {trailing ? <button>after</button> : null}
      </ModalShell>,
    )
    const frame = screen.getByTitle('prototype')
    const doc = frame instanceof HTMLIFrameElement ? frame.contentDocument : null
    if (!doc?.body) throw new Error('no frame document to write the prototype into')
    doc.body.innerHTML = inner
    /** Raise a key in the FRAME's document, as a browser does for a key pressed inside it. */
    const pressInFrame = (key: string, shiftKey = false) => {
      const target = doc.activeElement ?? doc.body
      target.dispatchEvent(
        new (doc.defaultView ?? window).KeyboardEvent('keydown', { key, shiftKey, bubbles: true }),
      )
    }
    /**
     * Raise a key in THIS page's document, with focus wherever the test put it.
     * `user.keyboard` cannot be used for the frame-element case: it dispatches at
     * `document.activeElement` only after its own focus bookkeeping, and the
     * `<iframe>` element having focus is precisely the state under test.
     */
    const pressInPage = (key: string, shiftKey = false) => {
      const target = document.activeElement ?? document.body
      target.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }))
    }
    return { doc, frame, pressInFrame, pressInPage }
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

  it('lets Tab into a frame that is the panel\'s last focusable', () => {
    // The direction the trap gets wrong by default, and the geometry the tests above
    // cannot see: with a control after the frame the frame is never `last`, so no wrap
    // fires. `PrototypeEnlargeButton`'s panel is `[Close, <iframe>]`, where the wrap
    // fires on the very keypress that would have descended into the artifact — and
    // `preventDefault()` cancels exactly that default action. Close ⇄ frame element
    // for ever, and every control inside the prototype is keyboard-unreachable in the
    // dialog built for walking through it.
    //
    // jsdom performs no default Tab action, so what is asserted is that the shell did
    // NOT intervene: focus is left on the frame element for the browser to descend
    // from. Redirected-to-`close` is the defect.
    const { frame, pressInPage } = renderFramedShell({ trailing: false })
    frame.focus()

    pressInPage('Tab')

    expect(frame).toHaveFocus()
    expect(screen.getByRole('button', { name: 'close' })).not.toHaveFocus()
  })

  it('wraps shift-Tab off a focused frame that is the panel\'s first focusable', () => {
    // Backwards there is no descent to protect — shift-Tab off a focused frame element
    // moves to whatever precedes the frame, never into it — so the trap must still act
    // at the panel's leading edge. Pinning it stops the entry fix above from being
    // widened into "never intervene while a frame has focus", which would let
    // shift-Tab out of the dialog and into the page behind.
    const { frame, pressInPage } = renderFramedShell({ leading: false })
    frame.focus()

    pressInPage('Tab', true)

    expect(screen.getByRole('button', { name: 'after' })).toHaveFocus()
  })

  it('wraps Tab off a frame with nothing focusable inside it', () => {
    // A frame the key cannot move focus within: the browser skips past it to whatever
    // follows, which is the page behind the overlay. Declining the wrap here would
    // strand a keyboard user outside the dialog, so an empty frame is not an entry.
    const { frame, pressInPage } = renderFramedShell({ trailing: false, inner: '<p>no controls here</p>' })
    frame.focus()

    pressInPage('Tab')

    expect(screen.getByRole('button', { name: 'close' })).toHaveFocus()
  })

  it('wraps Tab off a frame this page cannot read into', () => {
    // Cross-origin, or `sandbox` without `allow-same-origin` — how legacy `srcDoc`
    // prototypes render. There is no listener of ours inside such a frame to bring
    // focus back out, so letting Tab descend would be a one-way trip out of the
    // dialog. Today's wrap is the correct answer, and this pins that the entry fix
    // guards on readability rather than on the element being an iframe.
    render(
      <ModalShell isOpen onClose={onClose} ariaLabel="Opaque dialog">
        <button>close</button>
        <iframe title="opaque" />
      </ModalShell>,
    )
    const frame = screen.getByTitle('opaque')
    // Stand in for the browser refusing access: `frameDocument` catches the throw for
    // a cross-origin frame and returns null, which is the state under test. jsdom
    // enforces neither origins nor `sandbox`, so the refusal has to be arranged.
    Object.defineProperty(frame, 'contentDocument', {
      configurable: true,
      get() {
        throw new DOMException('cross-origin', 'SecurityError')
      },
    })
    frame.focus()

    frame.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))

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
    //
    // Listener IDENTITY, not just the event name: `expect(removals).toContain(
    // 'keydown')` passed for any keydown removal on that document by anyone, so it
    // stayed green if the shell detached the wrong handler, or only one of several —
    // a test that could not fail on the regression it is the sole guard against. What
    // is pinned here is that the exact function the shell ADDED is the one it removes.
    const added: EventListenerOrEventListenerObject[] = []
    const removed: EventListenerOrEventListenerObject[] = []
    // The spy has to exist before the shell attaches, and there is no moment in
    // between: jsdom creates a frame's document and fires its `load` synchronously
    // during insertion, which is when the shell attaches. Nor can the frame realm's
    // `EventTarget.prototype` be patched ahead of time — each frame has its own realm,
    // reachable only once the frame exists. So the spy is installed on the way IN, by
    // wrapping each frame document the first time anything reads it. `frameDocument()`
    // is that read.
    const restore = spyOnFrameDocumentListeners(added, removed)
    try {
      renderFramedShell()

      cleanup()
    } finally {
      restore()
    }

    // Anti-vacuous: "every added listener was removed" is satisfied by adding none,
    // which is also what a shell that stopped listening to frames at all would do —
    // the defect the rest of this describe exists to catch.
    expect(added.length).toBeGreaterThan(0)
    for (const listener of added) expect(removed).toContain(listener)
  })
})
