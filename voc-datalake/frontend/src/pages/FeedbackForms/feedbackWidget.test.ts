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
 * `value` as a JavaScript literal safe to inline in a `<script>`: JSON, with the
 * two sequences JSON leaves as-is but a script body cannot contain escaped —
 * `</` (would close the script element) and U+2028 / U+2029 (line terminators
 * in JS, plain characters in JSON).
 */
function jsLiteral(value: unknown): string {
  return JSON.stringify(value)
    .replace(/<\//g, '<\\/')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
}

/** What the stubbed API says when it refuses a submission (`data-submit="refuse"`). */
const REFUSAL_REASON = 'Feedback text must be at most 5000 characters'

/**
 * Run the widget against a `/config` answering `config`, the way the iframe page does.
 * `initOptions` is merged into the `init` call (e.g. the `dimensions` embed option).
 */
async function renderWidget(config: Record<string, unknown>, initOptions: Record<string, unknown> = {}): Promise<HTMLElement> {
  document.body.innerHTML = '<main id="voc-feedback-form"></main>'
  // The <script> runs in the jsdom window's own realm, which is not the test's
  // `globalThis`, so its `fetch` stub is defined inside the script itself. A GET
  // answers the config the way the API does. The DOM is shared, so a POST (the
  // submission) records its body on `<body data-posted>` for the test to read and
  // is answered per `<body data-submit>`: `refuse` is the API's 400 envelope,
  // `reject` a network failure, anything else a success.
  const answer = jsLiteral({ success: true, config })
  const refusal = jsLiteral({ success: false, error: REFUSAL_REASON })
  const fetchStub = [
    'window.fetch = function (url, init) {',
    `  if (!(init && init.body)) return Promise.resolve({ json: function () { return Promise.resolve(${answer}); } });`,
    '  document.body.dataset.posted = init.body;',
    "  if (document.body.dataset.submit === 'reject') return Promise.reject(new TypeError('Failed to fetch'));",
    `  var result = document.body.dataset.submit === 'refuse' ? ${refusal} : { success: true };`,
    '  return Promise.resolve({ json: function () { return Promise.resolve(result); } });',
    '};',
  ].join('\n')
  const init = jsLiteral({ container: '#voc-feedback-form', apiEndpoint: 'https://api.example.com', formId: 'f1', ...initOptions })
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

/** Answer the one text question and press Next, which submits; resolves once the POST left. */
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

/** The inline submit-failure notice (an alert region, hidden until a submission fails). */
function submitNotice(container: HTMLElement): HTMLElement {
  const notice = container.querySelector<HTMLElement>('.voc-submit-error[role="alert"]')
  if (notice === null) throw new Error('no submit notice')
  return notice
}

/**
 * Title of the slide the visitor is on. Every slide is in the DOM at once (the
 * thank-you copy included), so `textContent` of the container says nothing about
 * progress; the one shown is faded in (`opacity: 1`).
 */
function visibleSlideTitle(container: HTMLElement): string | undefined {
  return [...container.querySelectorAll<HTMLElement>('[data-index]')]
    .find((slide) => slide.style.opacity === '1')?.querySelector('h1, h2')?.textContent
}

afterEach(() => {
  document.body.innerHTML = ''
  delete document.body.dataset.posted
  delete document.body.dataset.submit
})

describe('the widget never renders dynamic text as HTML', () => {
  // Source pin behind the 3.14.02 removal of the unused `esc` helper: that helper
  // was dead because every string from the form config or the visitor reaches
  // the page through `textContent`. Keep it that way — a future
  // `el.innerHTML = config.title` is how a form author (or a poisoned config)
  // would get script into a customer's site.
  it('assigns innerHTML only constant markup, and dynamic strings via textContent', () => {
    // The right-hand side is captured as one single-quoted literal (entities such
    // as `&rarr;` contain `;`, so "up to the semicolon" would cut a literal short).
    const assignments = [...WIDGET_SOURCE.matchAll(/\.innerHTML\s*=\s*('(?:[^'\\]|\\.)*'|[^;\n]+)/g)].map((m) => m[1]?.trim() ?? '')
    expect(assignments.length).toBeGreaterThan(0)
    const nonLiteral = assignments.filter((rhs) => !/^'(?:[^'\\]|\\.)*'$/.test(rhs))
    expect(nonLiteral).toStrictEqual([])
    expect((WIDGET_SOURCE.match(/\.textContent\s*=/g) ?? []).length).toBeGreaterThan(10)
  })

  it('has no insertAdjacentHTML, outerHTML write, document.write or eval-like call', () => {
    expect(WIDGET_SOURCE).not.toMatch(/insertAdjacentHTML|\.outerHTML\s*=|document\.write|new Function\(|\beval\(/)
  })
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

describe('feedback widget rating buttons', () => {
  // Characterisation of the one helper that builds all three rating kinds
  // (3.14.04): `data-value` drives the posted rating, `data-label` the hover hint
  // (absent for numeric, so the hint falls back to "Click to rate"), and the
  // visible text is the face, the number or the star.
  const RATING = { ...BASE, rating_enabled: true, question: 'How was it?' }

  /** `[data-value, data-label, text]` of every rating button, in DOM order. */
  function ratingButtons(container: HTMLElement): Array<[string | undefined, string | undefined, string]> {
    return [...container.querySelectorAll<HTMLElement>('.voc-rating-btn')]
      .map((button) => [button.dataset.value, button.dataset.label, button.textContent])
  }

  it('renders stars 1..rating_max, each labelled for the hover hint', async () => {
    const buttons = ratingButtons(await renderWidget({ ...RATING, rating_type: 'stars', rating_max: 3 }))

    expect(buttons).toStrictEqual([['1', 'Poor', '\u2605'], ['2', 'Fair', '\u2605'], ['3', 'Good', '\u2605']])
  })

  it('gives a star past the five named labels an empty label, never the string "undefined"', async () => {
    const buttons = ratingButtons(await renderWidget({ ...RATING, rating_type: 'stars', rating_max: 6 }))

    expect(buttons.map(([, label]) => label)).toStrictEqual(['Poor', 'Fair', 'Good', 'Great', 'Excellent', ''])
  })

  it('renders numeric 1..10 whatever rating_max says, with no label attribute at all', async () => {
    const buttons = ratingButtons(await renderWidget({ ...RATING, rating_type: 'numeric', rating_max: 5 }))

    expect(buttons.map(([value]) => value)).toStrictEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(buttons.map(([value, , text]) => text === value)).not.toContain(false)
    expect(buttons.map(([, label]) => label)).toStrictEqual(Array.from({ length: 10 }))
  })

  it('renders five faces labelled Terrible to Amazing', async () => {
    const buttons = ratingButtons(await renderWidget({ ...RATING, rating_type: 'emoji' }))

    expect(buttons.map(([value, label]) => `${value}:${label}`)).toStrictEqual(['1:Terrible', '2:Bad', '3:Okay', '4:Good', '5:Amazing'])
    expect(buttons.map(([, , text]) => text.length > 0)).not.toContain(false)
  })

  // 5.34.00 live finding: the face and star buttons had no accessible name (a glyph only).
  it('names every face, star and number button by its value on the scale, inside a named group', async () => {
    const names = async (config: Record<string, unknown>) => {
      const container = await renderWidget({ ...RATING, ...config })
      expect(container.querySelector('.voc-rating-container')?.getAttribute('aria-label')).toBe('How was it?')
      return [...container.querySelectorAll('.voc-rating-btn')].map((button) => button.getAttribute('aria-label'))
    }
    expect(await names({ rating_type: 'emoji' })).toStrictEqual(
      ['Terrible (1 of 5)', 'Bad (2 of 5)', 'Okay (3 of 5)', 'Good (4 of 5)', 'Amazing (5 of 5)'])
    expect(await names({ rating_type: 'stars', rating_max: 6 })).toStrictEqual(
      ['1 star of 6: Poor', '2 stars of 6: Fair', '3 stars of 6: Good', '4 stars of 6: Great', '5 stars of 6: Excellent', '6 stars of 6'])
    expect((await names({ rating_type: 'numeric' })).at(-1)).toBe('10 of 10')
  })

  it('marks the chosen rating as pressed', async () => {
    const container = await renderWidget({ ...RATING, rating_type: 'emoji' })
    const okay = container.querySelector<HTMLButtonElement>('.voc-rating-btn[data-value="3"]')
    okay?.click()
    expect([...container.querySelectorAll('.voc-rating-btn')].map((button) => button.getAttribute('aria-pressed')))
      .toStrictEqual(['false', 'false', 'true', 'false', 'false'])
  })
})

describe('feedback widget submit failures', () => {
  // 3.15.00: a failed submission is told inline, in an alert region beside the
  // arrows, instead of a browser alert() that blocked the page and vanished on
  // close. The visitor's typed feedback stays in the form and Next retries.

  /** Render, answer the question and submit against a stub in `mode`; resolves once the notice is up. */
  async function submitAgainst(mode: 'refuse' | 'reject'): Promise<HTMLElement> {
    const container = await renderWidget(BASE)
    document.body.dataset.submit = mode
    await submitText(container)
    await waitFor(() => expect(submitNotice(container).style.display).toBe('block'))
    return container
  }

  it('never opens a browser alert', () => {
    expect(WIDGET_SOURCE).not.toMatch(/\balert\(/)
  })

  it("shows the API's own reason when it refuses the submission, and keeps the visitor on the question", async () => {
    const container = await submitAgainst('refuse')

    expect(submitNotice(container).textContent).toBe(REFUSAL_REASON)
    expect(container.querySelector('textarea')?.value).toBe('Checkout keeps failing')
    expect(visibleSlideTitle(container)).toBe('Tell us more')
  })

  it('falls back to a generic retry line when the request itself fails', async () => {
    const container = await submitAgainst('reject')

    expect(submitNotice(container).textContent).toBe('Failed to submit. Please try again.')
  })

  it('clears the notice and reaches the thank-you step when a retry succeeds', async () => {
    const container = await submitAgainst('reject')

    delete document.body.dataset.submit
    container.querySelector<HTMLElement>('[aria-label="Next question"]')?.click()

    await waitFor(() => expect(visibleSlideTitle(container)).toBe('Thank you!'))
    expect(submitNotice(container).style.display).toBe('none')
    expect(submitNotice(container).textContent).toBe('')
  })

  it('is hidden until something goes wrong', async () => {
    const container = await renderWidget(BASE)

    expect(submitNotice(container).style.display).toBe('none')
    expect(submitNotice(container).textContent).toBe('')
  })
})
