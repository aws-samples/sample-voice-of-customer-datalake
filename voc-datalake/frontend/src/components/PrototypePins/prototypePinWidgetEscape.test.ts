/**
 * #386: a key pressed inside the opaque-origin prototype frame never reaches the host page,
 * so the pin widget (lambda/shared/static/prototype-pin-widget.js) forwards an Escape it does
 * not use itself to the host, which closes its overlay (components/ModalShell/useFrameEscape).
 * `document.open()` erases the widget's listeners; its MutationObserver re-attaches them.
 *
 * ONE widget instance for the whole file (each evaluation adds window listeners that no
 * test could remove), so the cases run in order against it.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { isRecord } from '../../lib/typeGuards'

const WIDGET_SOURCE = readFileSync(
  resolve(__dirname, '../../../../lambda/shared/static/prototype-pin-widget.js'), 'utf-8')
const FORM_ID = 'pf_0123456789abcdef'
const ESCAPE = { source: 'voc-pin-widget', type: 'escape' }

const parent = { postMessage: vi.fn() }
const observers: Array<{ callback: MutationCallback; target: Node; options: MutationObserverInit | undefined }> = []

class RecordingObserver {
  private readonly callback: MutationCallback
  constructor(callback: MutationCallback) { this.callback = callback }
  observe(target: Node, options?: MutationObserverInit) { observers.push({ callback: this.callback, target, options }) }
  disconnect() { /* nothing to undo: the recorder holds no live observation */ }
  takeRecords(): MutationRecord[] { return [] }
}

/** The loaded widget's API (filled once, in beforeAll). */
const widget = new Map<string, unknown>()

function feedbackButton(): HTMLButtonElement {
  const button = document.getElementById('voc-pin-button')
  if (!(button instanceof HTMLButtonElement)) throw new Error('no Feedback button')
  return button
}

const escapesSent = () => parent.postMessage.mock.calls.filter(([data]) => isRecord(data) && data['type'] === 'escape')
/** As a focused control in the prototype raises it: window capture, then the document's own listeners. */
const pressEscape = () => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))

beforeAll(() => {
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
  vi.stubGlobal('MutationObserver', RecordingObserver)
  document.body.innerHTML = ''
  const evaluate: unknown = Reflect.get(window, 'eval')
  if (typeof evaluate !== 'function') throw new Error('no eval in this environment')
  Reflect.apply(evaluate, window, [WIDGET_SOURCE])
  const loaded: unknown = Reflect.get(window, 'VoCPinWidget')
  if (!isRecord(loaded) || typeof loaded['init'] !== 'function') throw new Error('the widget did not install window.VoCPinWidget')
  Reflect.apply(loaded['init'], undefined, [{ formId: FORM_ID }])
  for (const [key, value] of Object.entries(loaded)) widget.set(key, value)
})

afterAll(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(window, 'parent', { value: window, configurable: true })
})

describe('the pin widget forwards Escape to its host frame', () => {
  it('says it forwards Escape, so a host test can tell a widget built before 5.35', () => {
    expect(widget.get('forwardsEscape')).toBe(true)
  })

  it('posts the escape message, to the host\'s origin only, for an Escape it does not use', () => {
    parent.postMessage.mockClear()
    pressEscape()
    expect(escapesSent()).toStrictEqual([[ESCAPE, window.location.origin]])
  })

  it('keeps an Escape that cancels its own pin picking or closes its own panel', () => {
    feedbackButton().click() // picking starts, with a hint panel
    parent.postMessage.mockClear()
    pressEscape()
    expect(escapesSent()).toStrictEqual([])
    expect(document.getElementById('voc-pin-panel')).toBeNull()
    pressEscape() // nothing of the widget's is open any more: this one is the host's
    expect(escapesSent()).toHaveLength(1)
  })

  it('re-attaches its key listener when the document is rewritten (document.open erases it)', () => {
    const rewrite = observers.find((o) => o.target === document)
    expect(rewrite?.options).toStrictEqual({ childList: true })
    const added = vi.spyOn(window, 'addEventListener')
    rewrite?.callback([], new RecordingObserver(() => {}))
    expect(added.mock.calls.map(([type, , capture]) => [type, capture])).toStrictEqual([['message', undefined], ['keydown', true]])
    added.mockRestore()
  })
})
