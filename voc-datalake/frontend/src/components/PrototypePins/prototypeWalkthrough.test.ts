/**
 * The prototype walkthrough runtime (lambda/shared/static/prototype-walkthrough.js; docs/prototype-builder.md
 * Part 1), loaded from its real source into jsdom: the steps it accepts, the popup (a non-modal dialog named by
 * the step's title, "Step N of M", Next / Back / Skip / Don't show again, Done on the last, Left / Right, Esc
 * skips, the live region, text as text), the waiting step, standalone vs framed (the port handshake, the host's
 * start / pick, the events it reports) and the element picker.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import { isRecord } from '../../lib/typeGuards'

const SOURCE = readFileSync(resolve(__dirname, '../../../../lambda/shared/static/prototype-walkthrough.js'), 'utf-8')

const STEPS = [
  { title: 'Your order <b>status</b>', body: 'This card says when the parcel arrives.', selector: '#order' },
  { title: 'Pay', body: 'Place the order here.', anchor: { route: '', bbox: { x: 0.1, y: 0.6, w: 0.2, h: 0.05 } } },
]

function page(steps: unknown): void {
  document.body.innerHTML = '<div id="order">Order #1042</div><button id="outside">Outside</button>'
  if (steps !== undefined) {
    const block = document.createElement('script')
    block.type = 'application/json'
    block.id = 'voc-walkthrough-steps'
    block.textContent = JSON.stringify({ steps })
    document.body.appendChild(block)
  }
}

function load(): void {
  const evaluate: unknown = Reflect.get(window, 'eval')
  if (typeof evaluate !== 'function') throw new Error('no eval in this environment')
  Reflect.apply(evaluate, window, [SOURCE])
  const api: unknown = Reflect.get(window, 'VoCWalkthrough')
  if (!isRecord(api) || typeof api.init !== 'function') throw new Error('the runtime did not install window.VoCWalkthrough')
  Reflect.apply(api.init, undefined, [])
}

function runtime(): Record<string, unknown> {
  const api: unknown = Reflect.get(window, 'VoCWalkthrough')
  if (!isRecord(api)) throw new Error('no runtime')
  return api
}

/** Call one of the runtime's functions; its result is unknown until a test narrows it. */
function call(name: string, ...args: unknown[]): unknown {
  const fn: unknown = runtime()[name]
  if (typeof fn !== 'function') throw new Error(`VoCWalkthrough.${name} is not a function`)
  return Reflect.apply(fn, undefined, args)
}

const runtimeState = (): unknown => call('state')

const popup = () => screen.queryByRole('dialog')

afterEach(() => {
  document.body.innerHTML = ''
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
  window.history.replaceState(null, '', '/')
})

describe('its source', () => {
  // Inlined into a script element: a script end tag would end it, an HTML comment opener or the block's own
  // markers would confuse the server's strip and extract (which refuses such a runtime).
  it.each(['</script', '<!--', 'voc-walkthrough:'])('never contains %s', (fragment) => {
    expect(SOURCE.toLowerCase().includes(fragment)).toBe(false)
  })
})

describe('the steps it accepts', () => {
  beforeEach(() => { page(undefined); load() })

  it('keeps at most ten valid steps, caps the texts, and drops a step without a title, body or anchor', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ title: `T${String(i)}`, body: 'b', selector: '#x' }))
    expect(call('cleanSteps', many)).toHaveLength(10)
    const kept = call('cleanSteps', [
      { title: 'x'.repeat(100), body: 'y'.repeat(400), selector: '#a' },
      { title: '', body: 'b', selector: '#a' },
      { title: 't', body: 'b' },
      { title: 't', body: 'b', anchor: { route: '/', bbox: { x: 2, y: -1, w: 0.5, h: 0.5 } } },
    ])
    expect(kept).toStrictEqual([
      { title: 'x'.repeat(80), body: 'y'.repeat(280), selector: '#a', anchor: null },
      { title: 't', body: 'b', selector: '', anchor: { route: '/', bbox: { x: 1, y: 0, w: 0.5, h: 0.5 } } },
    ])
  })

  it('reads the server\'s block, not a decoy with its id placed earlier in the prototype\'s own markup', () => {
    document.body.innerHTML = ''
    const block = (title: string) => {
      const node = document.createElement('script')
      node.type = 'application/json'
      node.id = 'voc-walkthrough-steps'
      node.textContent = JSON.stringify({ steps: [{ title, body: 'b', selector: '#order' }] })
      return node
    }
    document.body.append(block('Decoy'), Object.assign(document.createElement('div'), { id: 'order' }), block('Real'))
    Object.defineProperty(window, 'parent', { value: { postMessage: vi.fn() }, configurable: true })
    load()
    call('start', 0)
    expect(popup()).toHaveAccessibleName('Real')
  })

  it('names a waiting step\'s screen from its route', () => {
    expect([call('screenName', '/checkout'), call('screenName', 'order-status')]).toStrictEqual(['Checkout', 'Order status'])
  })

  // One route vocabulary: the frame's hash without its '#', never the file (each saved version is a new one).
  it.each([
    [{ pathname: '/p/proto_1.html', hash: '#/checkout' }, '/checkout'],
    [{ pathname: '/p/proto_2.html', hash: '' }, ''],
    [{ pathname: '/p/proto_2.html', hash: '#step-2' }, 'step-2'],
  ])('the route of %o is %o', (location, route) => {
    expect(call('currentRoute', location)).toBe(route)
  })
})

describe('standalone (no parent frame)', () => {
  beforeEach(() => {
    page(STEPS)
    document.getElementById('outside')?.focus()
    load()
  })

  it('starts by itself: a dialog named by the title, the body as its description, text as text, focus in it', () => {
    const dialog = popup()
    expect(dialog).toHaveAccessibleName('Your order <b>status</b>')
    expect(dialog).toHaveAccessibleDescription('This card says when the parcel arrives.')
    expect(dialog?.querySelector('b')).toBeNull()
    expect(dialog).toHaveFocus()
  })

  it('says which step it is and that Don\'t show again lasts this page load', () => {
    const dialog = within(popup() ?? document.body)
    expect(dialog.getByText('Step 1 of 2')).toBeInTheDocument()
    expect(dialog.getByText(/lasts until this page is reloaded/)).toBeInTheDocument()
  })

  it('outlines the anchor and announces the step in a polite live region', () => {
    expect(document.getElementById('voc-wt-outline')).not.toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent('Step 1 of 2: Your order <b>status</b>')
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite')
  })

  it('goes Next and Back (also with Right and Left), and the last step\'s Next is Done', () => {
    fireEvent.click(screen.getByRole('button', { name: 'Next' }))
    expect(within(popup() ?? document.body).getByText('Step 2 of 2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument()
    fireEvent.keyDown(popup() ?? document.body, { key: 'ArrowLeft' })
    expect(within(popup() ?? document.body).getByText('Step 1 of 2')).toBeInTheDocument()
    fireEvent.keyDown(popup() ?? document.body, { key: 'ArrowRight' })
    fireEvent.click(screen.getByRole('button', { name: 'Done' }))
    expect(popup()).toBeNull()
  })

  it('Esc skips, and focus goes back where it was', () => {
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(popup()).toBeNull()
    expect(document.getElementById('outside')).toHaveFocus()
  })

  it('Don\'t show again closes it (it starts by itself only on a load)', () => {
    fireEvent.click(screen.getByRole('button', { name: "Don't show again" }))
    expect(popup()).toBeNull()
    expect(runtimeState()).toMatchObject({ index: -1 })
  })
})

describe('where the popup goes', () => {
  /** A 1200 x 900 frame window where the anchor (#order) and the popup have these boxes (jsdom lays nothing out). */
  function layout(anchor: { left: number; top: number; width: number; height: number }, popupHeight: number): void {
    Object.defineProperty(window, 'innerWidth', { value: 1200, configurable: true })
    Object.defineProperty(window, 'innerHeight', { value: 900, configurable: true })
    const box = (left: number, top: number, width: number, height: number) =>
      DOMRect.fromRect({ x: left, y: top, width, height })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.id === 'order') return box(anchor.left, anchor.top, anchor.width, anchor.height)
      if (this.id === 'voc-wt-popup') return box(0, 0, 320, popupHeight)
      return box(0, 0, 0, 0)
    })
    page(STEPS)
    load()
  }
  const placed = () => {
    const style = popup()?.style
    return { left: style?.left, top: style?.top, bottom: style?.bottom }
  }

  afterEach(() => { vi.restoreAllMocks() })

  it('an anchor at the window\'s bottom right edge: above it, its whole height and width inside the window', () => {
    layout({ left: 1100, top: 850, width: 90, height: 40 }, 260)
    // Below would end past 900; above: 850 - 8 - 260 = 582. Left: 1200 - 320 - 8 = 872.
    expect(placed()).toStrictEqual({ left: '872px', top: '582px', bottom: '' })
  })

  it('no room above or below the anchor: the bottom sheet', () => {
    layout({ left: 40, top: 100, width: 300, height: 700 }, 260)
    expect(placed()).toMatchObject({ bottom: '0px', top: '' })
  })

  it('a popup taller than the window: the bottom sheet (it scrolls inside)', () => {
    layout({ left: 40, top: 10, width: 100, height: 20 }, 1000)
    expect(placed()).toMatchObject({ bottom: '0px', top: '' })
  })
})

describe('a step on another screen', () => {
  const CHECKOUT = [{ title: 'Checkout', body: 'Pay here.', anchor: { route: '/checkout', bbox: { x: 0, y: 0, w: 0.1, h: 0.1 } } }]

  it('waits for it: Next is off and says which screen to open', () => {
    page(CHECKOUT)
    load()
    expect(within(popup() ?? document.body).getByText('Open the Checkout screen to continue')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled()
  })

  it('goes on once that screen is open (its hash), whatever file the version is', async () => {
    window.history.replaceState(null, '', '/p/proto_7.html')
    page(CHECKOUT)
    load()
    window.history.replaceState(null, '', '/p/proto_7.html#/checkout')
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled() }, { timeout: 2000 })
  })
})

describe('framed (the app\'s preview)', () => {
  function framed(steps: unknown) {
    const parent = { postMessage: vi.fn<(message: unknown, origin: string, transfer?: MessagePort[]) => void>() }
    Object.defineProperty(window, 'parent', { value: parent, configurable: true })
    page(steps)
    load()
    const [message, , transfer] = parent.postMessage.mock.calls[0] ?? []
    const port = transfer?.[0]
    if (port === undefined) throw new Error('no port handed over')
    const events: unknown[] = []
    port.onmessage = (e: MessageEvent) => { events.push(e.data) }
    return { message, port, events }
  }
  /** The pin widget every server-written version carries: its stable selector for an element (here its id). */
  const withPinWidget = () => {
    Reflect.set(window, 'VoCPinWidget', { buildSelector: (node: Element) => `#${node.id}` })
  }
  afterEach(() => { Reflect.deleteProperty(window, 'VoCPinWidget') })

  it('waits for the host, handing it a private port with the step count', () => {
    const { message } = framed(STEPS)
    expect(message).toStrictEqual({ type: 'voc-walkthrough', event: 'ready', steps: 2 })
    expect(popup()).toBeNull()
  })

  it('starts on the host\'s start (from a step), and reports how it ends: Skip, Don\'t show again', async () => {
    const { port, events } = framed(STEPS)
    port.postMessage({ type: 'voc-walkthrough', action: 'start', step: 1 })
    // A port delivers on a later task: wait for what it brings rather than for one tick.
    await vi.waitFor(() => { expect(popup()?.textContent).toContain('Step 2 of 2') })
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
    port.postMessage({ type: 'voc-walkthrough', action: 'start' })
    await vi.waitFor(() => { expect(popup()?.textContent).toContain('Step 1 of 2') })
    fireEvent.click(screen.getByRole('button', { name: "Don't show again" }))
    await vi.waitFor(() => {
      expect(events).toStrictEqual([
        { type: 'voc-walkthrough', event: 'skipped' },
        { type: 'voc-walkthrough', event: 'dont-show-again' },
      ])
    })
  })

  it('a preview never replaces the saved steps: it has no Don\'t show again, and a start without steps plays the saved ones', async () => {
    const { port } = framed(STEPS)
    port.postMessage({ type: 'voc-walkthrough', action: 'start', steps: [{ title: 'Draft step', body: 'Unsaved.', selector: '#order' }] })
    await vi.waitFor(() => { expect(popup()).toHaveAccessibleName('Draft step') })
    expect(screen.queryByRole('button', { name: "Don't show again" })).toBeNull()
    port.postMessage({ type: 'voc-walkthrough', action: 'start' })
    await vi.waitFor(() => { expect(popup()).toHaveAccessibleName('Your order <b>status</b>') })
    expect([screen.getByRole('button', { name: "Don't show again" }), runtimeState()])
      .toMatchObject([expect.anything(), { steps: 2, saved: 2, preview: false }])
  })

  it('a picked step, saved as the next version (a new file), shows on its screen there: pick, save, replay', async () => {
    window.history.replaceState(null, '', '/p/proto_1.html#/checkout')
    withPinWidget()
    const first = framed([])
    first.port.postMessage({ type: 'voc-walkthrough', action: 'pick' })
    await vi.waitFor(() => { expect(document.getElementById('voc-wt-pick-hint')).not.toBeNull() })
    fireEvent.click(document.getElementById('order') ?? document.body)
    await vi.waitFor(() => { expect(first.events).toHaveLength(1) })
    const [picked] = first.events
    expect(picked).toMatchObject({ event: 'picked', selector: '#order', anchor: { route: '/checkout' } })

    // The save writes the step into the next version, served as another file; replayed there, it is not waiting.
    const anchor = isRecord(picked) ? picked['anchor'] : undefined
    window.history.replaceState(null, '', '/p/proto_2.html#/checkout')
    const next = framed([{ title: 'Your order', body: 'Its date.', selector: '#order', anchor }])
    next.port.postMessage({ type: 'voc-walkthrough', action: 'start' })
    await vi.waitFor(() => { expect(screen.getByRole('button', { name: 'Done' })).toBeEnabled() })
  })

  it('without the pin widget, a pick records the element\'s position only', async () => {
    const { port, events } = framed([])
    port.postMessage({ type: 'voc-walkthrough', action: 'pick' })
    await vi.waitFor(() => { expect(document.getElementById('voc-wt-pick-hint')).not.toBeNull() })
    fireEvent.click(document.getElementById('order') ?? document.body)
    await vi.waitFor(() => {
      expect(events).toStrictEqual([{ type: 'voc-walkthrough', event: 'picked', anchor: { route: '', bbox: { x: 0, y: 0, w: 0, h: 0 } } }])
    })
  })

  it('picks an element for the editor: its selector and its position as shares of the viewport; Esc cancels', async () => {
    withPinWidget()
    const { port, events } = framed([])
    const hint = () => document.getElementById('voc-wt-pick-hint')
    port.postMessage({ type: 'voc-walkthrough', action: 'pick' })
    await vi.waitFor(() => { expect(hint()).not.toBeNull() })
    fireEvent.click(document.getElementById('order') ?? document.body)
    port.postMessage({ type: 'voc-walkthrough', action: 'pick' })
    await vi.waitFor(() => { expect(hint()).not.toBeNull() })
    fireEvent.keyDown(document, { key: 'Escape' })
    await vi.waitFor(() => {
      expect(events).toStrictEqual([
        { type: 'voc-walkthrough', event: 'picked', selector: '#order', anchor: { route: '', bbox: { x: 0, y: 0, w: 0, h: 0 } } },
        { type: 'voc-walkthrough', event: 'pick-cancelled' },
      ])
    })
  })
})
