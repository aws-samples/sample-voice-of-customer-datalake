/**
 * Runs the prototype pin widget (lambda/shared/static/prototype-pin-widget.js) in jsdom for the
 * `components/PrototypePins/prototypePinWidget*.test.ts` specs: a fresh instance per case, its API, the page framed
 * by a host that records its messages, a MessageChannel stand-in whose ports a case answers on, and `fetch` stubbed
 * (`installWidgetSandbox`: every case starts with an empty page and a reset `fetchMock`, and ends unframed).
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { isRecord } from '../lib/typeGuards'

const WIDGET_SOURCE = readFileSync(resolve(__dirname, '../../../lambda/shared/static/prototype-pin-widget.js'), 'utf-8')

export const FORM_ID = 'pf_0123456789abcdef'
export const SUBMIT_URL = `https://abcde12345.execute-api.us-east-1.amazonaws.com/v1/feedback-forms/${FORM_ID}/submit`

export function invoke(api: Record<string, unknown>, name: string, ...args: unknown[]): unknown {
  const fn: unknown = api[name]
  if (typeof fn !== 'function') throw new Error(`VoCPinWidget.${name} is not a function`)
  return Reflect.apply(fn, undefined, args)
}

/** A fresh widget instance initialised with `options`; returns its API. */
export function loadWidget(options: Record<string, unknown>): Record<string, unknown> {
  const evaluate: unknown = Reflect.get(window, 'eval')
  if (typeof evaluate !== 'function') throw new Error('no eval in this environment')
  Reflect.apply(evaluate, window, [WIDGET_SOURCE])
  const api: unknown = Reflect.get(window, 'VoCPinWidget')
  if (!isRecord(api)) throw new Error('the widget did not install window.VoCPinWidget')
  invoke(api, 'init', options)
  return api
}

/** Make the page look framed by the SPA viewer: a parent window that records postMessage. */
export function frameBy(parent: { postMessage: ReturnType<typeof vi.fn> }): void {
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
}

interface FakePort {
  onmessage: ((event: { data: unknown }) => void) | null
}

/** A MessageChannel stand-in: records the ports so a case can play the host's side. */
export function fakeChannels(): { port1: FakePort; port2: object }[] {
  const made: { port1: FakePort; port2: object }[] = []
  class FakeChannel {
    readonly port1: FakePort = { onmessage: null }
    readonly port2 = { transferred: true }
    constructor() {
      made.push(this)
    }
  }
  Object.defineProperty(window, 'MessageChannel', { value: FakeChannel, configurable: true })
  return made
}

/** The `fetch` every case's widget sees, and the hooks that reset the page around each case. */
export function installWidgetSandbox(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn()
  const originalChannel: unknown = Reflect.get(window, 'MessageChannel')
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    document.body.innerHTML = ''
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    Object.defineProperty(window, 'parent', { value: window, configurable: true })
    Object.defineProperty(window, 'MessageChannel', { value: originalChannel, configurable: true })
  })
  return fetchMock
}
