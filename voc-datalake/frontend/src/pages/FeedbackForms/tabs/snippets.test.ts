/**
 * The snippets a form is shared with (tabs/snippets.ts): the iframe and its resizer (run here against a real frame:
 * it takes the height only from that frame's window and the API's origin), the whole script embed and the SDK call
 * with the widget file from the app's origin, values that cannot break out of their JavaScript string, and nothing
 * while the endpoint cannot address the form.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { IFRAME_MIN_HEIGHT, WIDGET_PATH, iframeSnippet, scriptEmbedSnippet, sdkSnippet, widgetScriptUrl } from './snippets'
import type { SnippetInput } from './snippets'

const INPUT: SnippetInput = {
  apiEndpoint: 'https://api.example.com/v1/', formId: 'f_test', formName: 'Switching "back"', language: 'pl',
  hidden: [{ id: 'user_id', label: 'User' }], testToken: null,
}
const WIDGET = 'https://app.example.com/widget/feedback-widget.js'

/** The resizer's code: the iframe snippet's `<script>` body. */
function resizerOf(snippet: string): string {
  const body = /<script>\n([\s\S]*)\n<\/script>/.exec(snippet)?.[1]
  if (body === undefined) throw new Error('no resizer in the iframe snippet')
  return body
}

/** Put the iframe snippet's frame on the page and run its resizer, as a customer's page would. */
function mountIframe(snippet: string): HTMLIFrameElement {
  const frame = document.createElement('iframe')
  frame.id = 'voc-form-f_test'
  frame.style.height = '480px'
  document.body.append(frame)
  // A script element, as on the customer's page (jsdom runs it: vitest's jsdom environment runs scripts).
  const script = document.createElement('script')
  script.textContent = resizerOf(snippet)
  document.body.append(script)
  return frame
}

function post(data: unknown, source: MessageEventSource | null, origin: string): void {
  window.dispatchEvent(new MessageEvent('message', { data, source, origin }))
}

describe('snippets', () => {
  afterEach(() => {
    document.body.replaceChildren()
  })

  it('serves the widget from the app origin', () => {
    expect(WIDGET_PATH).toBe('/widget/feedback-widget.js')
    expect(widgetScriptUrl('https://app.example.com/')).toBe(WIDGET)
    expect(widgetScriptUrl()).toBe(`${window.location.origin}/widget/feedback-widget.js`)
  })

  it('gives the whole script embed: the element, the widget file and the init call', () => {
    expect(scriptEmbedSnippet({ ...INPUT, testToken: 'tk_1' }, WIDGET)).toBe([
      '<div id="voc-feedback-form"></div>',
      `<script src="${WIDGET}"></script>`,
      '<script>',
      '  VoCFeedbackForm.init({',
      "    container: '#voc-feedback-form',",
      "    apiEndpoint: 'https://api.example.com/v1',",
      "    formId: 'f_test',",
      "    // language: 'pl', // optional: one language for every visitor (else their browser's)",
      "    hidden: { user_id: '{USER_ID}' },",
      "    test: 'tk_1',",
      '  });',
      '</script>',
    ].join('\n'))
  })

  it('gives the SDK the widget file to load once, then the init call', () => {
    expect(sdkSnippet(INPUT, WIDGET)).toBe([
      `<script src="${WIDGET}"></script>`,
      '',
      'VoCFeedbackForm.init({',
      "  container: '#voc-feedback-form',",
      "  apiEndpoint: 'https://api.example.com/v1',",
      "  formId: 'f_test',",
      "  // language: 'pl', // optional: one language for every visitor (else their browser's)",
      "  hidden: { user_id: '{USER_ID}' },",
      '});',
    ].join('\n'))
  })

  it('keeps a value inside its JavaScript string and its attribute', () => {
    const snippet = scriptEmbedSnippet({ ...INPUT, hidden: [], testToken: "x'</script><b>" }, 'https://app.example.com/a"b')
    expect(snippet).toContain("test: 'x\\u0027\\u003c/script\\u003e\\u003cb\\u003e',")
    expect(snippet).toContain('<script src="https://app.example.com/a&quot;b"></script>')
    expect(snippet?.match(/<\/script>/g)).toHaveLength(2)
  })

  it('gives the iframe a 480 px height without script, its title, and the resizer after it', () => {
    const snippet = iframeSnippet(INPUT) ?? ''
    expect(snippet).toContain('<iframe\n  id="voc-form-f_test"\n  src="https://api.example.com/v1/feedback-forms/f_test/iframe"\n'
      + '  style="width: 100%; height: 480px; border: none;"\n  title="Switching &quot;back&quot;"\n></iframe>\n<script>')
    expect(snippet).toContain("event.origin !== 'https://api.example.com'")
  })

  it("grows the frame to the form's height, from that frame and the API's origin only", () => {
    const frame = mountIframe(iframeSnippet(INPUT) ?? '')
    const own = frame.contentWindow
    post({ type: 'voc-form-height', height: 812.4 }, own, 'https://api.example.com')
    expect(frame.style.height).toBe('813px')
    post({ type: 'voc-form-height', height: 40 }, own, 'https://api.example.com')
    expect(frame.style.height).toBe(`${String(IFRAME_MIN_HEIGHT)}px`)
    post({ type: 'voc-form-height', height: 2000 }, own, 'https://evil.example.com')
    post({ type: 'voc-form-height', height: 2000 }, window, 'https://api.example.com')
    post({ type: 'other', height: 2000 }, own, 'https://api.example.com')
    post({ type: 'voc-form-height', height: 'tall' }, own, 'https://api.example.com')
    expect(frame.style.height).toBe(`${String(IFRAME_MIN_HEIGHT)}px`)
  })

  it('gives nothing while the endpoint cannot address the form', () => {
    const local = { ...INPUT, apiEndpoint: '/api' }
    expect([iframeSnippet(local), scriptEmbedSnippet(local, WIDGET), sdkSnippet(local, WIDGET)]).toStrictEqual([null, null, null])
  })
})
