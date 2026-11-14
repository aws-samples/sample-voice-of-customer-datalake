/**
 * The page's side of a prototype's walkthrough (docs/prototype-builder.md Part 1), through the real bridge and
 * review frame: the runtime's ready message hands its port over; the walkthrough starts once by itself on a version
 * not yet seen, never once the series says "don't show again"; **Show walkthrough** replays it; a version without
 * steps shows no button; and a frame message only ever moves the viewer's own flag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { renderWithQueryClient } from '../../test/query-client'
import { useAuthStore } from '../../store/authStore'
import PrototypePinsReview from './PrototypePinsReview'

vi.mock('../../api/client', () => ({ api: { submitPrototypePin: vi.fn() }, fetchApi: vi.fn() }))

const HTML = '<!doctype html><html><body><div id="order">Order</div></body></html>'

function renderReview(documentId = 'proto_2', seriesKey = 'checkout') {
  renderWithQueryClient(
    <PrototypePinsReview projectId="p1" documentId={documentId} html={HTML} title="Checkout (v2)" canEdit={false} seriesKey={seriesKey} />,
  )
  const frame = screen.getByTitle<HTMLIFrameElement>('Checkout (v2)')
  return frame
}

/** The runtime's handshake: its ready message and a port; what the page sends back arrives on `received`. */
function ready(frame: HTMLIFrameElement, steps: number) {
  const channel = new MessageChannel()
  const received: unknown[] = []
  channel.port1.onmessage = (e: MessageEvent) => { received.push(e.data) }
  fireEvent(window, new MessageEvent('message', {
    data: { type: 'voc-walkthrough', event: 'ready', steps }, origin: 'null', source: frame.contentWindow, ports: [channel.port2],
  }))
  return { port: channel.port1, received }
}

const START = { type: 'voc-walkthrough', action: 'start', step: 0 }

// The suite's localStorage is a stub that stores nothing (src/test/setup.ts): these specs give it a memory.
const stored = new Map<string, string>()

beforeEach(() => {
  stored.clear()
  vi.spyOn(window.localStorage, 'getItem').mockImplementation((key: string) => stored.get(key) ?? null)
  vi.spyOn(window.localStorage, 'setItem').mockImplementation((key: string, value: string) => { stored.set(key, value) })
  useAuthStore.getState().setUser({ username: 'rui', email: 'rui@example.com', groups: [], sub: 'sub-rui' })
})

afterEach(() => {
  // Back to the setup stub's behavior (stores nothing, reads null) for the files after this one.
  vi.spyOn(window.localStorage, 'getItem').mockReset().mockReturnValue(null)
  vi.spyOn(window.localStorage, 'setItem').mockReset()
})

describe('the walkthrough host', () => {
  it('starts it once by itself on an unseen version, and offers Show walkthrough to replay it', async () => {
    const frame = renderReview()
    const first = ready(frame, 2)
    await vi.waitFor(() => { expect(first.received).toStrictEqual([START]) })

    // The same version again (a reload): seen, so it does not start by itself; Show walkthrough still does.
    const again = ready(frame, 2)
    await new Promise((done) => { setTimeout(done, 20) })
    expect(again.received).toStrictEqual([])
    fireEvent.click(await screen.findByRole('button', { name: 'Show walkthrough' }))
    await vi.waitFor(() => { expect(again.received).toStrictEqual([START]) })
  })

  it('never starts it by itself once the series says "don\'t show again", on any version of it', async () => {
    const frame = renderReview('proto_2')
    const first = ready(frame, 2)
    await vi.waitFor(() => { expect(first.received).toHaveLength(1) })
    first.port.postMessage({ type: 'voc-walkthrough', event: 'dont-show-again', step: 0 })
    await vi.waitFor(() => { expect(stored.get('voc-walkthrough:sub-rui:dont:p1:checkout')).toBe('1') })

    document.body.innerHTML = ''
    const next = ready(renderReview('proto_3'), 2)
    await new Promise((done) => { setTimeout(done, 20) })
    expect(next.received).toStrictEqual([])
  })

  it('shows no Show walkthrough for a version without steps, and starts nothing', async () => {
    const frame = renderReview()
    const none = ready(frame, 0)
    await new Promise((done) => { setTimeout(done, 20) })
    expect([none.received, screen.queryByRole('button', { name: 'Show walkthrough' })]).toStrictEqual([[], null])
  })

  it('forgets the last version\'s runtime when another is shown: a version without one has no Show walkthrough and says so', async () => {
    const review = (documentId: string) => (
      <PrototypePinsReview projectId="p1" documentId={documentId} html={HTML} title="Checkout" canEdit seriesKey="checkout" onSelectDoc={vi.fn()} />
    )
    const view = renderWithQueryClient(review('proto_2'))
    ready(screen.getByTitle<HTMLIFrameElement>('Checkout'), 2)
    expect(await screen.findByRole('button', { name: 'Show walkthrough' })).toBeInTheDocument()

    // A version written before 6.17.00: its frame sends no ready.
    view.rerender(review('proto_1'))
    fireEvent.click(screen.getByRole('button', { name: 'Walkthrough' }))
    expect(screen.queryByRole('button', { name: 'Show walkthrough' })).toBeNull()
    expect(screen.getByText(/was made before walkthroughs/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a step' })).toBeDisabled()
  })

  it('ignores a ready message from any window but its own frame', async () => {
    renderReview()
    const channel = new MessageChannel()
    const received: unknown[] = []
    channel.port1.onmessage = (e: MessageEvent) => { received.push(e.data) }
    fireEvent(window, new MessageEvent('message', { data: { type: 'voc-walkthrough', event: 'ready', steps: 2 }, origin: 'null', source: window, ports: [channel.port2] }))
    await new Promise((done) => { setTimeout(done, 20) })
    expect(received).toStrictEqual([])
  })
})
