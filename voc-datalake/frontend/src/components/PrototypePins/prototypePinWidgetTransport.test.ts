/**
 * How the prototype pin widget (lambda/shared/static/prototype-pin-widget.js) sends
 * a pin: to its host frame with postMessage when the SPA viewer frames it, straight
 * to its OWN form's public submit route when opened standalone with a submitUrl
 * (the one connect-src the prototype CSP grants, lib/utils/prototype-csp.ts), and
 * nowhere otherwise. Each case evaluates the real source afresh, so widget state
 * never leaks between cases.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../lib/typeGuards'

const WIDGET_SOURCE = readFileSync(
  resolve(__dirname, '../../../../lambda/shared/static/prototype-pin-widget.js'), 'utf-8')

const FORM_ID = 'pf_0123456789abcdef'
const SUBMIT_URL = `https://abcde12345.execute-api.us-east-1.amazonaws.com/v1/feedback-forms/${FORM_ID}/submit`
const BODY = { text: 'Make this bigger', pin: { selector: '#pay' } }

/** A fresh widget instance initialised with `options`; returns its API. */
function loadWidget(options: Record<string, unknown>): Record<string, unknown> {
  const evaluate: unknown = Reflect.get(window, 'eval')
  if (typeof evaluate !== 'function') throw new Error('no eval in this environment')
  Reflect.apply(evaluate, window, [WIDGET_SOURCE])
  const api: unknown = Reflect.get(window, 'VoCPinWidget')
  if (!isRecord(api)) throw new Error('the widget did not install window.VoCPinWidget')
  invoke(api, 'init', options)
  return api
}

function invoke(api: Record<string, unknown>, name: string, ...args: unknown[]): unknown {
  const fn: unknown = api[name]
  if (typeof fn !== 'function') throw new Error(`VoCPinWidget.${name} is not a function`)
  return Reflect.apply(fn, undefined, args)
}

function feedbackButton(): HTMLButtonElement {
  const button = document.getElementById('voc-pin-button')
  if (!(button instanceof HTMLButtonElement)) throw new Error('no Feedback button')
  return button
}

function panelText(): string {
  return document.getElementById('voc-pin-panel')?.textContent ?? ''
}

/** Make the page look framed by the SPA viewer: a parent window that records postMessage. */
function frameBy(parent: { postMessage: ReturnType<typeof vi.fn> }): void {
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
}

const fetchMock = vi.fn()
const ORIGINAL_MESSAGE_CHANNEL: unknown = Reflect.get(window, 'MessageChannel')

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  document.body.innerHTML = ''
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
  Object.defineProperty(window, 'MessageChannel', { value: ORIGINAL_MESSAGE_CHANNEL, configurable: true })
})

describe('standalone with its submit URL', () => {
  it('posts the pin directly to that URL, with no credentials, no Authorization header and no referrer', async () => {
    fetchMock.mockResolvedValue({ ok: true })
    const api = loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    expect(invoke(api, 'transport')).toBe('direct')

    await invoke(api, 'send', BODY)

    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(SUBMIT_URL, {
      method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(BODY),
    })
    expect(panelText()).toContain('your pin was saved')
  })

  it('says the pin was not saved when the route refuses it (rate limit, validation)', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 429 })
    const api = loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    await invoke(api, 'send', BODY)
    expect(panelText()).toContain('could not be saved')
  })

  it('says the pin was not saved when the request fails (CSP block, network)', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'))
    const api = loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    await invoke(api, 'send', BODY)
    expect(panelText()).toContain('could not be saved')
  })
})

describe('a submit URL that is not this form’s own submit route is ignored', () => {
  it.each([
    ['another form', SUBMIT_URL.replace(FORM_ID, 'pf_fedcba9876543210')],
    ['another route', SUBMIT_URL.replace('/submit', '/config')],
    ['plain http', SUBMIT_URL.replace('https://', 'http://')],
    ['a query string', `${SUBMIT_URL}?x=1`],
    ['not a string', 42],
  ])('%s', (_label, submitUrl) => {
    const api = loadWidget({ formId: FORM_ID, submitUrl })
    expect(invoke(api, 'transport')).toBe('none')
  })
})

describe('standalone without a submit URL', () => {
  it('sends nothing and tells the tester where to open the prototype', () => {
    const api = loadWidget({ formId: FORM_ID })
    expect(invoke(api, 'transport')).toBe('none')
    feedbackButton().click()
    expect(panelText()).toContain('Open this prototype from the VoC app')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('framed by the SPA viewer', () => {
  it('hands the pin to the host frame with postMessage and never calls the network, even with a submit URL', () => {
    const parent = { postMessage: vi.fn() }
    frameBy(parent)
    const api = loadWidget({ formId: FORM_ID, submitUrl: SUBMIT_URL })
    expect(invoke(api, 'transport')).toBe('host')

    invoke(api, 'send', BODY)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(parent.postMessage).toHaveBeenLastCalledWith(
      { source: 'voc-pin-widget', type: 'submit', formId: FORM_ID, requestId: 'r1', body: BODY },
      window.location.origin,
    )
  })
})

/** A MessageChannel stand-in: records the ports so a case can play the host's side. */
function fakeChannels() {
  const made: { port1: { onmessage: ((event: { data: unknown }) => void) | null }; port2: object }[] = []
  class FakeChannel {
    readonly port1: { onmessage: ((event: { data: unknown }) => void) | null } = { onmessage: null }
    readonly port2 = { transferred: true }
    constructor() {
      made.push(this)
    }
  }
  Object.defineProperty(window, 'MessageChannel', { value: FakeChannel, configurable: true })
  return made
}

/** A host 'show' message with one marker on `#target`. */
const SHOW_ON_TARGET = { source: 'voc-pin-host', type: 'show',
  pins: [{ pin_id: 'p1', number: 1, selector: '#target', bbox: { x: 0, y: 0, w: 0, h: 0 }, status: 'open' }] }

describe('framed, in an opaque-origin sandbox', () => {
  // The host cannot target an opaque window by origin, so the widget gives it a port.
  it('announces itself to the host origin only, transferring a private port', () => {
    const channels = fakeChannels()
    const parent = { postMessage: vi.fn() }
    frameBy(parent)
    loadWidget({ formId: FORM_ID })

    expect(parent.postMessage).toHaveBeenCalledWith(
      { source: 'voc-pin-widget', type: 'ready', formId: FORM_ID, review: false },
      window.location.origin,
      [channels[0]?.port2],
    )
  })

  it('takes the host answer and markers from that port', () => {
    const channels = fakeChannels()
    frameBy({ postMessage: vi.fn() })
    document.body.innerHTML = '<button id="target">t</button>'
    const api = loadWidget({ formId: FORM_ID })
    const fromHost = (data: unknown) => channels[0]?.port1.onmessage?.({ data })

    fromHost(SHOW_ON_TARGET)
    expect(document.getElementById('voc-pin-marker-0')?.textContent).toBe('1')

    invoke(api, 'send', BODY)
    fromHost({ source: 'voc-pin-host', type: 'result', requestId: 'r1', ok: true })
    expect(panelText()).toContain('your pin was saved')
  })

  it('takes markers the host posts on the window (targetOrigin *), from its parent only', () => {
    // The host's fallback for a widget without a port: it posts to this frame's
    // contentWindow with '*', and the event arrives carrying the host's origin.
    const parent = { postMessage: vi.fn() }
    frameBy(parent)
    document.body.innerHTML = '<button id="target">t</button>'
    loadWidget({ formId: FORM_ID })
    const fromWindow = (source: unknown) => {
      const event = new MessageEvent('message', { data: SHOW_ON_TARGET, origin: window.location.origin })
      Object.defineProperty(event, 'source', { value: source })
      window.dispatchEvent(event)
    }

    fromWindow(window)
    expect(document.getElementById('voc-pin-marker-0')).toBeNull()
    fromWindow(parent)
    expect(document.getElementById('voc-pin-marker-0')?.textContent).toBe('1')
  })
})
