/**
 * Runs the public widget (lambda/api/static/feedback-widget.js) in jsdom, the way its pages do, for the
 * `pages/FeedbackForms/feedbackWidget*.test.ts` specs.
 *
 * The widget's <script> runs in the jsdom window's own realm (`document.defaultView`), which is not the test's
 * `globalThis`, so its stubs (fetch, the browser's languages, matchMedia) are defined inside the script itself
 * and read their knobs from `<body data-*>`, which both realms share:
 * - `data-browser-language` / `data-browser-languages` (comma list): the browser's languages (default en-US);
 * - `data-media`: words the matchMedia stub matches ('reduce', 'fine', 'dark'); `setDeviceDark` changes 'dark' and
 *   fires the listeners the widget added (a device switching between light and dark);
 * - `data-config-mode="reject"`: the config fetch fails;
 * - `data-submit="reject"`: the submission fails at the network; `data-submit-status` / `data-submit-body`: its answer;
 * - `data-beacon="refuse"`: navigator.sendBeacon refuses (returns false), so the widget falls back to a keepalive fetch.
 * Every fetch is recorded on `<body data-calls>` (URL, method, parsed body), and every navigator.sendBeacon on
 * `<body data-sent-beacons>` (URL, parsed body).
 *
 * The widget draws in an open shadow root of its container (7.55.01): `widgetRoot(container)` is its inner root
 * there, which every helper below queries, and `focused(container)` the element with the focus inside it.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { waitFor } from '@testing-library/react'
import { expect } from 'vitest'

export const WIDGET_SOURCE = readFileSync(resolve(__dirname, '../../../lambda/api/static/feedback-widget.js'), 'utf8')

/** One question of a schema version 2 form (the contract's shape; the tests write what they need). */
export type Question = Record<string, unknown> & { id: string, type: string }

/** A fetch the widget made. */
interface Call { url: string, method: string, body: Record<string, unknown> | null }

/** What `init` returns: the handle the SDK and the editor's preview drive. */
interface WidgetHandle {
  setHiddenFields: (values: Record<string, unknown>) => void
  update: (config: Record<string, unknown>) => void
  /** A question's id, 'welcome' or 'end:<ending id>'. */
  goTo: (target: string) => void
  restart: () => void
  setLanguage: (language: string) => void
  setScheme: (scheme: 'light' | 'dark' | null) => void
  destroy: () => void
}

/**
 * `value` as a JavaScript literal safe to inline in a `<script>`: JSON, with the two sequences JSON leaves as-is
 * but a script body cannot contain escaped — `</` (would close the script element) and U+2028 / U+2029.
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** A live form of schema version 2 in English, with `questions` and one ending ("Thanks!"). */
export function form(questions: Question[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    enabled: true, schema_version: 2, revision: 3, language: 'en', languages: ['en'], welcome: { enabled: false },
    questions, hidden_fields: [], endings: [{ id: 'end_thanks', title: { en: 'Thanks!' } }], theme: {}, ...extra,
  }
}

/** An I18nText in English. */
export function en(text: string): Record<string, string> {
  return { en: text }
}

/** An optional one-line open text question headed `title` (plus `extra`). */
export function openText(id: string, title: string, extra: Record<string, unknown> = {}): Question {
  return { id, type: 'open_text', headline: en(title), required: false, long: false, input_type: 'text', ...extra }
}

function stubs(answer: unknown): string {
  return [
    "Object.defineProperty(navigator, 'language', { configurable: true, get: function () { var d = document.body.dataset; return 'browserLanguage' in d ? d.browserLanguage : 'en-US'; } });",
    "Object.defineProperty(navigator, 'languages', { configurable: true, get: function () { var d = document.body.dataset; if ('browserLanguages' in d) return d.browserLanguages ? d.browserLanguages.split(',') : []; return 'browserLanguage' in d ? [d.browserLanguage] : ['en-US']; } });",
    "Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: function (url, data) { var d = document.body.dataset; if (d.beacon === 'refuse') return false; var sent = JSON.parse(d.sentBeacons || '[]'); sent.push({ url: String(url), body: JSON.parse(String(data)) }); d.sentBeacons = JSON.stringify(sent); return true; } });",
    // The listeners live on <body> (`__vocMedia`), so `setDeviceDark` can fire them from the test's realm.
    "window.matchMedia = function (query) { var matches = function () { var m = document.body.dataset.media || ''; return (query.indexOf('reduce') >= 0 && m.indexOf('reduce') >= 0) || (query.indexOf('pointer: fine') >= 0 && m.indexOf('fine') >= 0) || (query.indexOf('prefers-color-scheme: dark') >= 0 && m.indexOf('dark') >= 0); }; var listeners = document.body.__vocMedia || (document.body.__vocMedia = []); var add = function (type, fn) { listeners.push({ query: query, fn: fn }); }; var remove = function (type, fn) { for (var i = listeners.length - 1; i >= 0; i--) if (listeners[i].fn === fn) listeners.splice(i, 1); }; return { get matches() { return matches(); }, media: query, addEventListener: add, removeEventListener: remove, addListener: function (fn) { add('change', fn); }, removeListener: function (fn) { remove('change', fn); } }; };",
    'window.fetch = function (url, init) {',
    '  var d = document.body.dataset;',
    "  var calls = JSON.parse(d.calls || '[]');",
    "  calls.push({ url: String(url), method: (init && init.method) || 'GET', body: init && init.body ? JSON.parse(init.body) : null });",
    '  d.calls = JSON.stringify(calls);',
    '  if (!(init && init.body)) {',
    "    if (d.configMode === 'reject') return Promise.reject(new TypeError('Failed to fetch'));",
    `    return Promise.resolve({ ok: true, status: 200, json: function () { return Promise.resolve(${jsLiteral(answer)}); } });`,
    '  }',
    "  if (d.submit === 'reject') return Promise.reject(new TypeError('Failed to fetch'));",
    '  var status = d.submitStatus ? Number(d.submitStatus) : 200;',
    '  var result = d.submitBody ? JSON.parse(d.submitBody) : { success: true };',
    '  return Promise.resolve({ ok: status < 300, status: status, json: function () { return Promise.resolve(result); } });',
    '};',
  ].join('\n')
}

interface RenderSetup {
  /** The config route's whole answer (default `{success: true, config}`). */
  answer?: unknown
  /** The page's path and query when the script loads (e.g. the API's iframe page with `?hf_user_id=…`). */
  path?: string
  /** Script run after the widget is defined and before `init` (what the API's iframe page sets). */
  beforeInit?: string
}

/**
 * Call `init` and leave its handle and the widget's namespace on <body> (`__voc`, `__vocApi`): DOM nodes are the
 * one thing both realms share (the script's `window` is not reachable from the test).
 */
function EXPOSE(init: string): string {
  return `document.body.__vocApi = VoCFeedbackForm; document.body.__voc = VoCFeedbackForm.init(${init});`
}

function runScript(body: string): void {
  const script = document.createElement('script')
  script.textContent = body
  document.body.appendChild(script)
}

/** Run the widget with a config route answering `config`; resolves once it rendered something. */
export async function renderWidget(config: Record<string, unknown>, initOptions: Record<string, unknown> = {},
  setup: RenderSetup = {}): Promise<HTMLElement> {
  document.body.innerHTML = '<main id="voc-feedback-form"></main>'
  const init = jsLiteral({ container: '#voc-feedback-form', apiEndpoint: 'https://api.example.com', formId: 'f1', ...initOptions })
  const path = setup.path === undefined ? '' : `history.replaceState(null, '', ${jsLiteral(setup.path)});`
  runScript([path, stubs(setup.answer ?? { success: true, config }), WIDGET_SOURCE, setup.beforeInit ?? '',
    EXPOSE(init)].join('\n'))
  const container = document.querySelector<HTMLElement>('#voc-feedback-form')
  if (container === null) throw new Error('no container')
  // In the shadow root, or in the container itself where the page has no Shadow DOM.
  await waitFor(() => expect((container.shadowRoot ?? container).querySelector('.voc-root')?.textContent ?? '').not.toBe(''))
  return container
}

/** The widget's inner root in the container's shadow root: the strip, the progress bar, the live region and the
 * screen, or a status message. */
export function widgetRoot(container: HTMLElement): HTMLElement {
  const shadow = container.shadowRoot
  if (shadow === null) throw new Error('the widget drew no shadow root')
  return required(shadow.querySelector<HTMLElement>('.voc-root'), 'widget root')
}

/** The element with the focus inside the widget (null when the focus is elsewhere). */
export function focused(container: HTMLElement): Element | null {
  return container.shadowRoot?.activeElement ?? null
}

/** A listener the widget added on the matchMedia stub (`__vocMedia` on <body>). */
interface MediaListener { readonly query: string, readonly call: (event: { matches: boolean, media: string }) => void }

function schemeListeners(): MediaListener[] {
  const raw: unknown = Reflect.get(document.body, '__vocMedia')
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry: unknown): MediaListener[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const query: unknown = Reflect.get(entry, 'query')
    const fn: unknown = Reflect.get(entry, 'fn')
    if (typeof query !== 'string' || !query.includes('prefers-color-scheme') || typeof fn !== 'function') return []
    return [{ query, call: (event) => { Reflect.apply(fn, undefined, [event]) } }]
  })
}

/** How many prefers-color-scheme listeners the widget has on the matchMedia stub. */
export function schemeListenerCount(): number {
  return schemeListeners().length
}

/** The device switches between light and dark (prefers-color-scheme): the stub's answer, then its listeners. */
export function setDeviceDark(dark: boolean): void {
  const words = (document.body.dataset.media ?? '').split(' ').filter((word) => word !== '' && word !== 'dark')
  document.body.dataset.media = (dark ? [...words, 'dark'] : words).join(' ')
  for (const listener of schemeListeners()) listener.call({ matches: dark, media: listener.query })
}

/** The editor's preview: the widget given `config` itself (`preview: {config}`), never fetching. */
export function renderPreview(config: Record<string, unknown>, initOptions: Record<string, unknown> = {}): HTMLElement {
  document.body.innerHTML = '<main id="voc-feedback-form"></main>'
  const init = jsLiteral({ container: '#voc-feedback-form', preview: { config }, ...initOptions })
  runScript([stubs({ success: true, config }), WIDGET_SOURCE, EXPOSE(init)].join('\n'))
  const container = document.querySelector<HTMLElement>('#voc-feedback-form')
  if (container === null) throw new Error('no container')
  return container
}

/** What the script left on <body> under `key` (EXPOSE), checked to have the `method` the test calls. */
function exposed(key: '__voc' | '__vocApi', method: string): object {
  const value: unknown = Reflect.get(document.body, key)
  if (typeof value !== 'object' || value === null || !(method in value)) throw new Error(`the widget left no ${key}`)
  return value
}

function isHandle(value: unknown): value is WidgetHandle {
  return typeof value === 'object' && value !== null && 'goTo' in value && 'setHiddenFields' in value
}

/** The handle the last `init` returned. */
export function handle(): WidgetHandle {
  const value = exposed('__voc', 'setHiddenFields')
  if (!isHandle(value)) throw new Error('init returned no handle')
  return value
}

/** `VoCFeedbackForm.setHiddenFields`, the SDK's call for every form on the page. */
export function setHiddenFieldsForPage(values: Record<string, unknown>): void {
  const api = exposed('__vocApi', 'setHiddenFields')
  const call: unknown = Reflect.get(api, 'setHiddenFields')
  if (typeof call !== 'function') throw new Error('no VoCFeedbackForm.setHiddenFields')
  Reflect.apply(call, api, [values])
}

/** Clear what a run left on the page and the shared knobs. */
export function resetWidgetPage(): void {
  document.body.innerHTML = ''
  for (const name of document.body.getAttributeNames()) {
    if (name.startsWith('data-')) document.body.removeAttribute(name)
  }
  document.documentElement.removeAttribute('lang')
  document.documentElement.removeAttribute('style')
  document.title = ''
  Reflect.deleteProperty(document, 'visibilityState')
  Reflect.deleteProperty(document.body, '__vocMedia')
  window.history.replaceState(null, '', '/')
}

/** Every fetch so far. */
export function calls(): Call[] {
  const parsed: unknown = JSON.parse(document.body.dataset.calls ?? '[]')
  return Array.isArray(parsed) ? parsed.map((call: Call) => call) : []
}

/** The submissions so far (POSTs to …/submit), their bodies. */
export function submissions(): Array<Record<string, unknown>> {
  return calls().filter((call) => call.method === 'POST' && call.url.endsWith('/submit')).map((call) => call.body ?? {})
}

/** D6's `opened` and `left` beacons so far (navigator.sendBeacon calls): their URL and parsed body. */
export function sentBeacons(): Array<{ url: string, body: Record<string, unknown> }> {
  const parsed: unknown = JSON.parse(document.body.dataset.sentBeacons ?? '[]')
  return Array.isArray(parsed) ? parsed.map((sent: { url: string, body: Record<string, unknown> }) => sent) : []
}

/** The page is being left (`pagehide`). */
export function leavePage(): void {
  window.dispatchEvent(new Event('pagehide'))
}

/** The page goes hidden (`visibilitychange` with visibilityState "hidden": a tab switch, a phone's home button). */
export function hidePage(): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
  document.dispatchEvent(new Event('visibilitychange'))
}

/** The `answers` of a submission's body. */
export function answersOf(body: Record<string, unknown>): Record<string, unknown> {
  const answers = body.answers
  return typeof answers === 'object' && answers !== null && !Array.isArray(answers) ? { ...answers } : {}
}

/** Choose `value` in the screen's native select, as a respondent does. */
export function selectValue(container: HTMLElement, value: string): void {
  const select = required(screen(container).querySelector('select'), 'select')
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Wait for the first submission and return its body. */
export async function submitted(): Promise<Record<string, unknown>> {
  await waitFor(() => expect(submissions().length).toBeGreaterThan(0))
  return submissions()[0] ?? {}
}

function required<T extends Element>(element: T | null | undefined, what: string): T {
  if (element === null || element === undefined) throw new Error(`no ${what}`)
  return element
}

/** The screen on show (only one is in the page at a time). */
export function screen(container: HTMLElement): HTMLElement {
  return required(widgetRoot(container).querySelector<HTMLElement>('.voc-screen'), 'screen')
}

/** The heading of the screen on show (its question, the welcome title or the ending title). */
export function heading(container: HTMLElement): string {
  return screen(container).querySelector('h1, h2')?.textContent ?? ''
}

export function nextButton(container: HTMLElement): HTMLButtonElement {
  return required(widgetRoot(container).querySelector<HTMLButtonElement>('.voc-next'), 'Next button')
}

export function backButton(container: HTMLElement): HTMLButtonElement {
  return required(widgetRoot(container).querySelector<HTMLButtonElement>('.voc-back'), 'Back button')
}

export function clickNext(container: HTMLElement): void {
  nextButton(container).click()
}

export function clickStart(container: HTMLElement): void {
  required(widgetRoot(container).querySelector<HTMLButtonElement>('.voc-start'), 'Start button').click()
}

/** The error under the question on show ('' when none). */
export function errorText(container: HTMLElement): string {
  return widgetRoot(container).querySelector('.voc-error')?.textContent ?? ''
}

/** The notice by the buttons (sending failed, refused, form changed). */
export function noticeText(container: HTMLElement): string {
  const notice = widgetRoot(container).querySelector<HTMLElement>('.voc-submit-error')
  return notice === null || notice.hidden ? '' : notice.querySelector('span')?.textContent ?? ''
}

/** Type `text` into the screen's text field (or the field matching `selector`). */
export function typeText(container: HTMLElement, text: string, selector = '.voc-input'): void {
  const field = required(screen(container).querySelector<HTMLInputElement | HTMLTextAreaElement>(selector), selector)
  field.value = text
  field.dispatchEvent(new Event('input', { bubbles: true }))
}

/** What a screen reader reads for `node`: its text without the parts hidden from it (glyphs, drawn faces). */
export function accessibleText(node: Element): string {
  const copy = node.cloneNode(true)
  if (!(copy instanceof Element)) return ''
  for (const hidden of copy.querySelectorAll('[aria-hidden="true"]')) hidden.remove()
  return copy.textContent.trim()
}

/** The choice whose label reads `words` to a screen reader (a list row, a chip, a scale cell's name). */
export function choice(container: HTMLElement, words: string): HTMLInputElement {
  const label = [...screen(container).querySelectorAll('label')].find((candidate) => accessibleText(candidate) === words)
  return required(label?.querySelector('input'), `choice "${words}"`)
}

/**
 * Pick the choice `words` as a keyboard does (checked, then a change event, with no pointer first). A radio
 * in a group unchecks its siblings by itself.
 */
export function pickByKey(container: HTMLElement, words: string): void {
  const input = choice(container, words)
  input.checked = input.type === 'checkbox' ? !input.checked : true
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

/** Pick the choice `words` with a pointer (a press on it, then its click). */
export function pickByPointer(container: HTMLElement, words: string): void {
  const input = choice(container, words)
  input.dispatchEvent(new Event('pointerdown', { bubbles: true }))
  input.click()
}

/** The words of every choice row on the screen, in order. */
export function choiceWords(container: HTMLElement): string[] {
  return [...screen(container).querySelectorAll('.voc-opt')].map((label) => label.textContent.trim())
}

/** Wait until the screen's heading reads `text` (an assertion). */
export async function expectHeading(container: HTMLElement, text: string): Promise<void> {
  await waitFor(() => expect(heading(container)).toBe(text))
}

/** Press `key` on the screen's element matching `selector`. Returns whether something handled it. */
export function pressIn(container: HTMLElement, selector: string, key: string, init: KeyboardEventInit = {}): boolean {
  return press(required(screen(container).querySelector(selector), selector), key, init)
}

/** Press `key` on `target` (bubbling, as a real key press). Returns whether something handled it. */
export function press(target: Element, key: string, init: KeyboardEventInit = {}): boolean {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event.defaultPrevented
}
