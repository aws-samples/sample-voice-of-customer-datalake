/**
 * The host half of the prototype pin widget: the bridge forwards a validated pin to
 * the public submit route and answers the frame; editors get the pin list, threads,
 * resolve / reopen and markers. Messages from anywhere but the frame are ignored.
 */
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderWithQueryClient } from '../../test/query-client'
import { hideMessage, parseWidgetMessage, showMessage } from './pinMessages'
import PrototypePinsReview from './PrototypePinsReview'
import type { PrototypePin } from '../../api/prototypePinsApi'

const mocks = vi.hoisted(() => ({
  submit: vi.fn<(formId: string, body: unknown) => Promise<unknown>>(),
  fetchApi: vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>(),
}))

vi.mock('../../api/client', () => ({
  api: { submitPrototypePin: mocks.submit },
  fetchApi: mocks.fetchApi,
}))

const FORM_ID = 'pf_0123456789abcdef'
const PINS_PATH = '/projects/proj_1/prototypes/prototype_1/pins'
const PIN = {
  pin_id: 'pin_20261005120000000000abcdef', status: 'open', comment: 'The Pay button does nothing',
  flagged: false, created_at: '2026-10-05T12:00:00Z', addressed_by: null,
  anchor: { selector: '#pay', text_snippet: 'Pay now', route: '#/checkout', bbox: { x: 1, y: 2, w: 3, h: 4 } },
  console: [{ level: 'error', message: 'TypeError' }], replies: [],
}

function frameWindow(): Window {
  const frame = document.querySelector('iframe')
  if (!frame?.contentWindow) throw new Error('no prototype frame')
  return frame.contentWindow
}

function fromFrame(data: unknown, origin = window.location.origin) {
  window.dispatchEvent(new MessageEvent('message', { data, origin, source: frameWindow() }))
}

const submitMessage = {
  source: 'voc-pin-widget', type: 'submit', formId: FORM_ID, requestId: 'r1',
  body: { text: 'Broken button', pin: { selector: '#pay' } },
}

function renderReview(canEdit: boolean) {
  return renderWithQueryClient(
    <PrototypePinsReview projectId="proj_1" documentId="prototype_1" url="https://app.example/prototypes/p.html"
      title="Prototype" canEdit={canEdit} />,
  )
}

beforeEach(() => {
  mocks.submit.mockReset().mockResolvedValue({ success: true })
  mocks.fetchApi.mockReset().mockImplementation((endpoint) => {
    if (endpoint === PINS_PATH) return Promise.resolve({ pins: [PIN, { status: 'open' }] })
    if (endpoint.endsWith('/resolve')) return Promise.resolve({ pin: { ...PIN, status: 'resolved' } })
    if (endpoint.endsWith('/replies')) return Promise.resolve({ pin: PIN })
    return Promise.reject(new Error(`unrouted ${endpoint}`))
  })
})

describe('the bridge', () => {
  it('forwards a widget pin to the public submit route and answers the frame', async () => {
    renderReview(false)
    const post = vi.spyOn(frameWindow(), 'postMessage')

    fromFrame(submitMessage)

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      { source: 'voc-pin-host', type: 'result', requestId: 'r1', ok: true }, window.location.origin))
    expect(mocks.submit).toHaveBeenCalledWith(FORM_ID, submitMessage.body)
  })

  it('reports a failed submit back to the widget', async () => {
    mocks.submit.mockRejectedValue(new Error('API Error: 429'))
    renderReview(false)
    const post = vi.spyOn(frameWindow(), 'postMessage')

    fromFrame(submitMessage)

    await waitFor(() => expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'result', ok: false }), window.location.origin))
  })

  it('ignores another origin, another window and malformed messages', () => {
    renderReview(false)
    fromFrame(submitMessage, 'https://evil.example')
    window.dispatchEvent(new MessageEvent('message', { data: submitMessage, origin: window.location.origin, source: window }))
    fromFrame({ ...submitMessage, formId: "x'); alert(1)" })
    fromFrame({ ...submitMessage, body: { text: '', pin: {} } })

    expect(mocks.submit).not.toHaveBeenCalled()
  })

  it('does not list pins for someone who cannot edit the project', () => {
    renderReview(false)
    expect(screen.queryByRole('button', { name: /Tester pins/ })).toBeNull()
    expect(mocks.fetchApi).not.toHaveBeenCalled()
  })
})

describe('the review overlay', () => {
  async function openPanel() {
    fireEvent.click(screen.getByRole('button', { name: 'Tester pins' }))
    await screen.findByText('Tester pins (1)')
  }

  it('fetches nothing until the panel is opened', () => {
    renderReview(true)
    expect(mocks.fetchApi).not.toHaveBeenCalled()
  })

  it('lists pins (dropping id-less ones) with their anchor, and resolves one', async () => {
    renderReview(true)
    await openPanel()

    expect(screen.getByText('The Pay button does nothing')).toBeInTheDocument()
    expect(screen.getByText('#pay')).toBeInTheDocument()
    expect(screen.getByText('Console errors: 1')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Resolve/ }))
    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(`${PINS_PATH}/${PIN.pin_id}/resolve`,
      { method: 'POST' }))
  })

  it('sends a reply', async () => {
    renderReview(true)
    await openPanel()

    fireEvent.change(screen.getByPlaceholderText('Reply to the tester…'), { target: { value: 'On it' } })
    fireEvent.click(screen.getByRole('button', { name: 'Reply' }))

    await waitFor(() => expect(mocks.fetchApi).toHaveBeenCalledWith(`${PINS_PATH}/${PIN.pin_id}/replies`,
      { method: 'POST', body: JSON.stringify({ text: 'On it' }) }))
  })

  it('posts markers to the frame when asked, and only markers', async () => {
    renderReview(true)
    await openPanel()
    const post = vi.spyOn(frameWindow(), 'postMessage')

    fireEvent.click(screen.getByRole('checkbox', { name: 'Show pins on the prototype' }))

    await waitFor(() => expect(post).toHaveBeenCalledWith(expect.objectContaining({ type: 'show' }), window.location.origin))
    expect(JSON.stringify(post.mock.calls)).not.toContain('The Pay button does nothing')
  })

  it('opens itself with markers when the prototype was opened with ?review=1', async () => {
    renderReview(true)
    fromFrame({ source: 'voc-pin-widget', type: 'ready', formId: FORM_ID, review: true })

    await screen.findByText('Tester pins (1)')
    expect(screen.getByRole('checkbox', { name: 'Show pins on the prototype' })).toBeChecked()
  })
})

describe('pin messages', () => {
  it('accepts a ready message and defaults its review flag', () => {
    expect(parseWidgetMessage({ source: 'voc-pin-widget', type: 'ready', formId: FORM_ID }))
      .toStrictEqual({ source: 'voc-pin-widget', type: 'ready', formId: FORM_ID, review: false })
  })

  it.each([null, 'x', { source: 'other', type: 'submit' }, { ...submitMessage, requestId: 'r'.repeat(41) },
    { ...submitMessage, body: { text: 'x'.repeat(2001), pin: {} } }])('rejects %j', (data) => {
    expect(parseWidgetMessage(data)).toBeNull()
  })

  it('numbers markers in list order and carries no comment', () => {
    const pin: PrototypePin = { ...PIN, status: 'open', addressed_by: '' }
    expect(showMessage([pin, { ...pin, pin_id: 'p2' }])).toStrictEqual({
      source: 'voc-pin-host', type: 'show', pins: [
        { pin_id: PIN.pin_id, number: 1, selector: '#pay', bbox: PIN.anchor.bbox, status: 'open' },
        { pin_id: 'p2', number: 2, selector: '#pay', bbox: PIN.anchor.bbox, status: 'open' },
      ],
    })
    expect(hideMessage()).toStrictEqual({ source: 'voc-pin-host', type: 'hide' })
  })
})
