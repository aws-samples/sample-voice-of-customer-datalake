/**
 * The public widget (lambda/api/static/feedback-widget.js), run in jsdom (E2E F6).
 *
 * axe flagged a serious colour-contrast failure on its start button: the label
 * was always white, and the old default primary (#3B82F6) gives 3.68:1. The
 * default is now the Kiro accent, and the label picks whichever of white / Kiro
 * strong text reads better on the fill, so a customer's own colour is kept.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { waitFor } from '@testing-library/react'

const WIDGET_SOURCE = readFileSync(resolve(__dirname, '../../../../lambda/api/static/feedback-widget.js'), 'utf8')

/**
 * Run the widget against a `/config` answering `config`, the way the iframe page does.
 * `initOptions` is merged into the `init` call (e.g. the `dimensions` embed option).
 */
async function renderWidget(config: Record<string, unknown>, initOptions: Record<string, unknown> = {}): Promise<HTMLElement> {
  document.body.innerHTML = '<main id="voc-feedback-form"></main>'
  // The <script> runs in the jsdom window's own realm, which is not the test's
  // `globalThis`, so its `fetch` stub is defined inside the script itself and
  // answers the config the way the API does. The DOM is shared, so a POST body
  // is recorded on `<body data-posted>` for the test to read.
  const answer = JSON.stringify({ success: true, config })
  const fetchStub = `window.fetch = function (url, init) { if (init && init.body) document.body.dataset.posted = init.body; return Promise.resolve({ json: function () { return Promise.resolve(${answer}); } }); };`
  const init = JSON.stringify({ container: '#voc-feedback-form', apiEndpoint: 'https://api.example.com', formId: 'f1', ...initOptions })
  const script = document.createElement('script')
  script.textContent = `${fetchStub}\n${WIDGET_SOURCE}\nVoCFeedbackForm.init(${init});`
  document.body.appendChild(script)
  const container = document.querySelector<HTMLElement>('#voc-feedback-form')
  if (container === null) throw new Error('no container')
  await waitFor(() => expect(container.textContent).not.toBe(''))
  return container
}

function startButton(container: HTMLElement): HTMLElement {
  const button = container.querySelector<HTMLElement>('.voc-start')
  if (button === null) throw new Error('no start button')
  return button
}

const BASE = { enabled: true, title: 'How likely are you to recommend us?', description: 'One question.', rating_enabled: false }

afterEach(() => {
  document.body.innerHTML = ''
})

describe('feedback widget colours', () => {
  it('defaults to the Kiro accent with a white label (4.64:1, AA)', async () => {
    const button = startButton(await renderWidget(BASE))

    expect(button.style.background).toBe('rgb(142, 72, 255)')
    expect(button.style.color).toBe('rgb(255, 255, 255)')
  })

  it("keeps a customer's light primary and gives it the dark label", async () => {
    const button = startButton(await renderWidget({ ...BASE, theme: { primary_color: '#3B82F6' } }))

    expect(button.style.background).toBe('rgb(59, 130, 246)')
    // White on #3B82F6 is 3.68:1; #19161d on it is 4.86:1.
    expect(button.style.color).toBe('rgb(25, 22, 29)')
  })

  it('keeps white on a dark customer primary', async () => {
    const button = startButton(await renderWidget({ ...BASE, theme: { primary_color: '#285092' } }))

    expect(button.style.color).toBe('rgb(255, 255, 255)')
  })

  it('defaults page text and background to Kiro Light', async () => {
    const container = await renderWidget(BASE)

    expect(container.style.color).toBe('rgb(25, 22, 29)')
    expect(container.style.background).toBe('rgb(255, 255, 255)')
  })
})

describe('feedback widget states', () => {
  it('announces a disabled form as a status message', async () => {
    const container = await renderWidget({ ...BASE, enabled: false })

    const status = container.querySelector('[role="status"]')
    expect(status?.textContent).toBe('Feedback form unavailable.')
  })

  it('names its icon-only arrow buttons', async () => {
    const container = await renderWidget(BASE)

    expect(container.querySelector('button[aria-label="Previous question"]')).not.toBeNull()
    expect(container.querySelector('button[aria-label="Next question"]')).not.toBeNull()
  })
})

describe('feedback widget dimensions embed option', () => {
  /** Answer the one text question and submit; the posted body. */
  async function submitText(container: HTMLElement): Promise<unknown> {
    startButton(container).click()
    const textarea = container.querySelector('textarea')
    if (textarea === null) throw new Error('no text step')
    textarea.value = 'Checkout keeps failing'
    textarea.dispatchEvent(new Event('input'))
    container.querySelector<HTMLElement>('[aria-label="Next question"]')?.click()
    await waitFor(() => expect(document.body.dataset.posted).toBeDefined())
    return JSON.parse(document.body.dataset.posted ?? '{}')
  }

  it('sends the embed dimensions (plain string values only) for the server to merge under the form defaults', async () => {
    const container = await renderWidget(BASE, { dimensions: { user_type: 'partner', nested: { x: 1 } } })
    const posted = await submitText(container)
    // The server lets the form's own dimension_defaults win per key (docs/feedback-forms.md).
    expect(posted).toHaveProperty('dimensions', { user_type: 'partner' })
    expect(posted).toHaveProperty('text', 'Checkout keeps failing')
  })

  it('sends no dimensions without the option', async () => {
    const posted = await submitText(await renderWidget(BASE))
    expect(posted).not.toHaveProperty('dimensions')
  })
})
