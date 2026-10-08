/**
 * The prototype pin widget's own logic (lambda/shared/static/prototype-pin-widget.js),
 * loaded from its real source into jsdom: selector building, redaction (the same
 * table as the server's TestRedaction in lambda/api/test/test_prototype_pins.py),
 * payload caps, console capture and the review markers.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../lib/typeGuards'

const WIDGET_SOURCE = readFileSync(
  resolve(__dirname, '../../../../lambda/shared/static/prototype-pin-widget.js'), 'utf-8')

function widget(): Record<string, unknown> {
  const candidate: unknown = Reflect.get(window, 'VoCPinWidget')
  if (!isRecord(candidate)) throw new Error('the widget did not install window.VoCPinWidget')
  return candidate
}

/** Call one of the widget's functions; its result is unknown until a test narrows it. */
function call(name: string, ...args: unknown[]): unknown {
  const fn: unknown = widget()[name]
  if (typeof fn !== 'function') throw new Error(`VoCPinWidget.${name} is not a function`)
  return Reflect.apply(fn, undefined, args)
}

const text = (name: string, ...args: unknown[]): string => {
  const value = call(name, ...args)
  if (typeof value !== 'string') throw new Error(`${name} did not return a string`)
  return value
}

function payload(target: Element, comment: string): Record<string, unknown> {
  return record(fullPayload(target, comment).pin, 'buildPayload pin')
}

function fullPayload(target: Element | null, comment: string): Record<string, unknown> {
  return record(call('buildPayload', target, comment, window), 'buildPayload result')
}

/** Narrowing helpers, so the cases themselves stay free of conditionals. */
function record(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${what} is not an object`)
  return value
}

function list(value: unknown, what: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`)
  return value
}

function present<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`${what} is missing`)
  return value
}

function button(value: unknown): HTMLButtonElement {
  if (!(value instanceof HTMLButtonElement)) throw new Error('no button')
  return value
}

/** The recorded console messages, each read as a string. */
function consoleMessages(): string[] {
  return list(call('consoleEntries'), 'consoleEntries').map((entry) => String(record(entry, 'console entry').message))
}

beforeAll(() => {
  const script = document.createElement('script')
  script.textContent = WIDGET_SOURCE
  document.head.appendChild(script)
  if (!Reflect.has(window, 'VoCPinWidget')) {
    // jsdom builds without script execution: evaluate it the way a page would.
    const evaluate: unknown = Reflect.get(window, 'eval')
    if (typeof evaluate === 'function') Reflect.apply(evaluate, window, [WIDGET_SOURCE])
  }
  call('init', { formId: 'pf_0123456789abcdef' })
})

beforeEach(() => {
  document.body.querySelectorAll('[data-fixture]').forEach((el) => el.remove())
})

function fixture(html: string): HTMLElement {
  const root = document.createElement('div')
  root.dataset.fixture = 'true'
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}

describe('redaction mirrors the server', () => {
  it.each([
    ['mail a.b+c@ex.co.uk now', 'mail [email] now'],
    ['Authorization: Bearer abc.def', 'Authorization: Bearer [redacted]'],
    ['api_key=sk_live_123 next', 'api_key=[redacted] next'],
    ['card 4111 1111 1111 1111', 'card [number]'],
    ['id 1234', 'id 1234'],
    ['session a1B2c3D4e5F6g7H8i9J0k1L2m3', 'session [token]'],
    ['the key press handler', 'the key press handler'],
  ])('%s', (raw, expected) => {
    expect(text('redact', raw)).toBe(expected)
  })
})

describe('stable selectors', () => {
  it('prefers a unique id', () => {
    const root = fixture('<section><button id="pay">Pay</button></section>')
    expect(text('buildSelector', root.querySelector('#pay'), document)).toBe('#pay')
  })

  it('walks nth-of-type up to an id-bearing ancestor', () => {
    const root = fixture('<div id="shell"><ul><li>a</li><li><button>b</button></li></ul></div>')
    const button = root.querySelector('li:nth-of-type(2) button')
    const selector = text('buildSelector', button, document)
    expect(selector).toBe('#shell > ul > li:nth-of-type(2) > button')
    expect(document.querySelector(selector)).toBe(button)
  })

  it('ignores a duplicated id', () => {
    const root = fixture('<p><span id="dup">1</span><span id="dup">2</span></p>')
    const second = root.querySelectorAll('span')[1]
    expect(text('buildSelector', second, document)).not.toContain('#dup')
  })
})

describe('payload', () => {
  it('caps the snippet and comment, and strips the signed query from the route', () => {
    const root = fixture(`<p id="long">${'word '.repeat(200)}</p>`)
    const value = fullPayload(root.querySelector('#long'), 'c'.repeat(5000))
    const pin = record(value.pin, 'buildPayload pin')
    expect(String(value.text)).toHaveLength(2000)
    expect(String(pin.text_snippet).length).toBeLessThanOrEqual(200)
    expect(text('currentRoute', { pathname: '/prototypes/p/prototype_1.html', hash: '#/pay', search: '?Signature=x' }))
      .toBe('prototype_1.html#/pay')
  })

  it('carries a bbox in viewport percent and the viewport itself', () => {
    const root = fixture('<button id="b">b</button>')
    const target = present(root.querySelector('#b'), 'fixture')
    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue(DOMRect.fromRect({ x: 512, y: 384, width: 2048, height: 10 }))
    const pin = payload(target, 'x')
    expect(pin.bbox).toStrictEqual({ x: 50, y: 50, w: 100, h: 1.3 })
    expect(pin.viewport).toStrictEqual({ w: window.innerWidth, h: window.innerHeight })
  })

  it('keeps the last 20 console errors, each redacted and at most 500 chars', () => {
    for (const i of Array.from({ length: 25 }, (_, index) => index)) {
      call('record', 'error', [`failure ${i} for jane@example.com ${'x'.repeat(600)}`])
    }
    const messages = consoleMessages()
    expect(messages).toHaveLength(20)
    for (const message of messages) {
      expect(message.length).toBeLessThanOrEqual(500)
      expect(message).not.toContain('@example.com')
    }
  })

  it('captures console.error through its own listener', () => {
    const quiet = vi.spyOn(console, 'error')
    console.error('boom token=abc123def')
    expect(consoleMessages().at(-1)).toContain('token=[redacted]')
    quiet.mockRestore()
  })
})

describe('in the page', () => {
  it('mounts one Feedback button and explains where to open a standalone prototype', () => {
    const buttons = document.querySelectorAll('#voc-pin-button')
    expect(buttons).toHaveLength(1)
    button(buttons.item(0)).click()
    expect(document.getElementById('voc-pin-panel')?.textContent).toContain('Open this prototype from the VoC app')
  })

  it('draws numbered markers on a show message from its host, and clears them on hide', () => {
    fixture('<button id="target">t</button>')
    const show = { source: 'voc-pin-host', type: 'show',
      pins: [{ pin_id: 'p1', number: 1, selector: '#target', bbox: { x: 0, y: 0, w: 0, h: 0 }, status: 'open' }] }
    window.dispatchEvent(new MessageEvent('message', { data: show, origin: window.location.origin, source: window }))
    expect(document.getElementById('voc-pin-marker-0')?.textContent).toBe('1')

    window.dispatchEvent(new MessageEvent('message', { data: { source: 'voc-pin-host', type: 'hide' },
      origin: window.location.origin, source: window }))
    expect(document.getElementById('voc-pin-marker-0')).toBeNull()
  })

  it('ignores messages from another origin', () => {
    const show = { source: 'voc-pin-host', type: 'show',
      pins: [{ pin_id: 'p1', number: 1, selector: '', bbox: { x: 1, y: 1, w: 1, h: 1 }, status: 'open' }] }
    window.dispatchEvent(new MessageEvent('message', { data: show, origin: 'https://evil.example', source: window }))
    expect(document.getElementById('voc-pin-marker-0')).toBeNull()
  })
})
