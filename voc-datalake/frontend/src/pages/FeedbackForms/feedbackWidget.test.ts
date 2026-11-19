/**
 * The public widget (lambda/api/static/feedback-widget.js), run in jsdom: its no-HTML rule, its colours, its
 * states (unavailable, failed to load, sending, refused, changed), the `dimensions` option, and a version 1 config
 * (one cached from before 7.04.00), which it migrates by the contract's rules and answers with the version 1 body.
 *
 * axe once flagged a serious colour-contrast failure on the start button: the label was always white, and the old
 * default primary (#3B82F6) gives 3.68:1. The default is the Kiro accent, and the label picks whichever of white
 * or Kiro strong text reads better on the fill, so a customer's own colour is kept (E2E F6).
 */
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { supportedLanguages } from '../../i18n/languages'
import {
  WIDGET_SOURCE, backButton, calls, clickNext, clickStart, en, errorText, form, heading, expectHeading,
  nextButton, noticeText, pickByKey, renderWidget, resetWidgetPage, screen, submissions, submitted, typeText, widgetRoot,
} from '../../test/feedbackWidgetHarness'
import { WIDGET_START_LABEL, widgetLanguage } from './test/widgetLanguage'

afterEach(resetWidgetPage)

/** A version 1 config: a welcome title, no rating, one text question. */
const BASE = { enabled: true, title: 'How likely are you to recommend us?', description: 'One question.', rating_enabled: false }

function startButton(container: HTMLElement): HTMLElement {
  const button = widgetRoot(container).querySelector<HTMLElement>('.voc-start')
  if (button === null) throw new Error('no start button')
  return button
}

/** Start a version 1 form, answer its text question and press Next (which submits); resolves with the body. */
async function submitText(container: HTMLElement): Promise<Record<string, unknown>> {
  clickStart(container)
  typeText(container, 'Checkout keeps failing')
  clickNext(container)
  return submitted()
}

const TEXT = { id: 'q_text', type: 'open_text', headline: en('What happened?'), required: true, long: true }
const PICK = {
  id: 'q_pick', type: 'single_select', headline: en('Why?'), required: true,
  options: [{ code: 'price', label: en('Price') }, { code: 'bugs', label: en('Bugs') }],
}

describe('the widget never renders dynamic text as HTML', () => {
  // A future `el.innerHTML = config.title` is how a form author (or a poisoned config) would get script into a
  // customer's site: every string from the config or the respondent goes through textContent.
  it('assigns innerHTML only constant markup, and dynamic strings via textContent', () => {
    const assignments = [...WIDGET_SOURCE.matchAll(/\.innerHTML\s*=\s*('(?:[^'\\]|\\.)*'|[^;\n]+)/g)].map((m) => m[1]?.trim() ?? '')
    const nonLiteral = assignments.filter((rhs) => !/^'(?:[^'\\]|\\.)*'$/.test(rhs))

    expect(assignments.length).toBeGreaterThan(0)
    expect(nonLiteral).toStrictEqual([])
    expect((WIDGET_SOURCE.match(/\.textContent\s*=/g) ?? []).length).toBeGreaterThan(10)
  })

  it('has no insertAdjacentHTML, outerHTML write, document.write or eval-like call, and never a browser alert', () => {
    expect(WIDGET_SOURCE).not.toMatch(/insertAdjacentHTML|\.outerHTML\s*=|document\.write|new Function\(|\beval\(|\balert\(/)
  })

  it('shows markup in a headline and an option as text', async () => {
    const markup = '<img src=x onerror="document.body.dataset.pwned=1">'
    const container = await renderWidget(form([{ ...PICK, headline: en(markup), options: [{ code: 'a', label: en(markup) }] }]))

    expect(heading(container)).toBe(markup)
    expect(widgetRoot(container).querySelector('img')).toBeNull()
    expect(document.body.dataset.pwned).toBeUndefined()
  })

  it.each([
    ['javascript:', 'javascript:alert(1)'], ['http', 'http://example.com/more'], ['data:', 'data:text/html,hi'],
    ['credentials', 'https://user:pw@example.com/'], ['a space', 'https://example.com/a b'],
  ])('renders no link for a %s address (https only)', async (_case, url) => {
    const container = await renderWidget(form([
      { id: 'q_info', type: 'statement', headline: en('Read this'), required: false, cta: { label: en('More'), url } },
    ]))

    expect(widgetRoot(container).querySelector('a')).toBeNull()
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

    expect(widgetRoot(container).style.color).toBe('rgb(25, 22, 29)')
    expect(widgetRoot(container).style.background).toBe('rgb(255, 255, 255)')
  })

  it('falls back to the defaults for a stored colour that is not a hex value, so no CSS reaches the page', async () => {
    const injected = 'red;position:fixed;inset:0;z-index:2147483647'
    const container = await renderWidget({
      ...BASE, theme: { primary_color: injected, background_color: injected, text_color: 'rgb(0,0,0)', border_radius: injected },
    })

    expect({
      position: widgetRoot(container).style.position, zIndex: widgetRoot(container).style.zIndex,
      background: widgetRoot(container).style.background, color: widgetRoot(container).style.color,
    }).toStrictEqual({ position: 'relative', zIndex: '', background: 'rgb(255, 255, 255)', color: 'rgb(25, 22, 29)' })
    expect(startButton(container).style.background).toBe('rgb(142, 72, 255)')
    expect(startButton(container).style.borderRadius).toBe('8px')
  })
})

describe('feedback widget states', () => {
  it('announces a disabled form as a status message', async () => {
    const container = await renderWidget({ ...BASE, enabled: false })

    expect(widgetRoot(container).querySelector('[role="status"]')?.textContent).toBe('Feedback form unavailable.')
  })

  it("says the form couldn't load when the config route can't be reached", async () => {
    document.body.dataset.configMode = 'reject'
    const container = await renderWidget(BASE)

    expect(widgetRoot(container).querySelector('[role="status"]')?.textContent)
      .toBe("Couldn't load this form. Check your connection and reload the page.")
  })

  it('labels its Back and Next buttons, each at least 48 px tall, and hides Back on the first question', async () => {
    const container = await renderWidget(form([TEXT, PICK]))
    typeText(container, 'Slow')
    clickNext(container)

    expect([backButton(container).textContent, nextButton(container).textContent]).toStrictEqual(['Back', 'Submit'])
    expect([backButton(container).style.minHeight, nextButton(container).style.minHeight]).toStrictEqual(['48px', '48px'])
    backButton(container).click()
    expect(backButton(container).hidden).toBe(true)
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
    expect(await submitText(await renderWidget(BASE))).not.toHaveProperty('dimensions')
  })
})

describe('sending the answers', () => {
  it('says "Sending…" on a Next that cannot be pressed twice', async () => {
    const container = await renderWidget(form([TEXT]))
    typeText(container, 'Slow')
    clickNext(container)
    clickNext(container)

    expect([nextButton(container).textContent, nextButton(container).disabled]).toStrictEqual(['Sending…', true])
    await expectHeading(container, 'Thanks!')
    expect(submissions()).toHaveLength(1)
  })

  it('keeps the answers when the network fails, and Try again sends them', async () => {
    const container = await renderWidget(form([TEXT]))
    document.body.dataset.submit = 'reject'
    typeText(container, 'Slow')
    clickNext(container)
    await waitFor(() => expect(noticeText(container)).toBe("Couldn't send your answers. Check your connection and try again."))
    delete document.body.dataset.submit

    widgetRoot(container).querySelector<HTMLButtonElement>('.voc-notice-action')?.click()

    await expectHeading(container, 'Thanks!')
    expect(submissions().map((body) => body.answers)).toStrictEqual([{ q_text: 'Slow' }, { q_text: 'Slow' }])
  })

  it("goes back to the question the server refused, in the respondent's words, never the server's English", async () => {
    const container = await renderWidget(form([{ ...TEXT, long: false, input_type: 'email', required: false }, PICK]))
    document.body.dataset.submitStatus = '400'
    document.body.dataset.submitBody = JSON.stringify({
      success: false, error: 'answers.q_text must be an email address', code: 'answer_invalid', question_id: 'q_text',
    })
    typeText(container, 'a@b.co')
    clickNext(container)
    pickByKey(container, 'Price')
    clickNext(container)

    await expectHeading(container, 'What happened?')
    expect([noticeText(container), errorText(container)]).toStrictEqual(["Some answers couldn't be accepted.", '✕ Enter a valid email address.'])
    expect(widgetRoot(container).textContent).not.toContain('must be an email address')
  })

  it('says the form changed while answering (409), and Reload loads it again', async () => {
    const container = await renderWidget(form([TEXT]))
    document.body.dataset.submitStatus = '409'
    typeText(container, 'Slow')
    clickNext(container)
    await waitFor(() => expect(noticeText(container)).toBe('This form was updated while you were answering. Reload to answer the latest version.'))

    widgetRoot(container).querySelector<HTMLButtonElement>('.voc-notice-action')?.click()

    await waitFor(() => expect(calls().filter((call) => call.method === 'GET')).toHaveLength(2))
    await expectHeading(container, 'What happened?')
  })

  it('says a test link no longer works when the server refuses its token (403)', async () => {
    const container = await renderWidget(form([TEXT]), { test: 'tk_old' })
    document.body.dataset.submitStatus = '403'
    typeText(container, 'Slow')
    clickNext(container)

    await waitFor(() => expect(widgetRoot(container).querySelector('[role="status"]')?.textContent).toBe('This test link no longer works.'))
  })
})

describe('the question each step shows (a customer pilot, 7.04.00), from a version 1 config', () => {
  // The pilot's Polish form had no rating, and its Question never appeared: the text step always read the hard-coded
  // English "Tell us more". A version 1 config is migrated in the widget by the contract's rules.
  it('titles the text step with the question when the form has no rating', async () => {
    const container = await renderWidget({ ...BASE, question: 'Dlaczego rezygnujesz?' })
    clickStart(container)

    expect(heading(container)).toBe('Dlaczego rezygnujesz?')
    expect(screen(container).querySelector('textarea')).not.toBeNull()
  })

  it('keeps the question for the rating when there is one, and titles the text step with the follow-up', async () => {
    const container = await renderWidget({
      ...BASE, rating_enabled: true, rating_type: 'stars', question: 'How was it?', text_question: 'What should we change?',
    })
    clickStart(container)
    const rating = heading(container)
    pickByKey(container, '4 of 5')
    clickNext(container)

    expect([rating, heading(container)]).toStrictEqual(['How was it?', 'What should we change?'])
  })

  it.each([
    ['no follow-up (a form saved before it existed)', {}],
    ['an empty follow-up', { text_question: '' }],
    ['a blank follow-up', { text_question: '   ' }],
  ])('says "Tell us more" after the rating with %s', async (_case, followUp) => {
    const container = await renderWidget({ ...BASE, rating_enabled: true, question: 'How was it?', ...followUp })
    clickStart(container)
    pickByKey(container, '3 of 5')
    clickNext(container)

    expect(heading(container)).toBe('Tell us more')
  })

  it('says "Tell us more" for a form with neither a rating nor a question', async () => {
    const container = await renderWidget(BASE)
    clickStart(container)

    expect(heading(container)).toBe('Tell us more')
  })

  it('ignores the follow-up of a form without a rating', async () => {
    const container = await renderWidget({ ...BASE, question: 'What happened?', text_question: 'Left over from a rating' })
    clickStart(container)

    expect(heading(container)).toBe('What happened?')
  })

  it("keeps the form's own thank-you message in its language", async () => {
    const container = await renderWidget({ ...BASE, language: 'pl', success_message: 'Dzięki!' })
    await submitText(container)

    await expectHeading(container, 'Dzięki!')
  })
})

describe('a version 1 config answered with the version 1 body', () => {
  const FULL = {
    ...BASE, rating_enabled: true, rating_type: 'stars', rating_max: 6, question: 'How was it?', placeholder: 'Tell us…',
    collect_name: true, collect_email: true, success_message: 'Thanks a lot',
  }

  it('asks the rating (its exact maximum), the text and the contact step, and sends text, rating, name and email', async () => {
    const container = await renderWidget(FULL)
    clickStart(container)
    const stars = screen(container).querySelectorAll('input[type="radio"]').length
    pickByKey(container, '6 of 6')
    clickNext(container)
    typeText(container, 'Great')
    clickNext(container)
    typeText(container, 'Ana', 'input[autocomplete="name"]')
    typeText(container, 'ana@example.com', 'input[autocomplete="email"]')
    clickNext(container)

    expect(stars).toBe(6)
    expect(await submitted()).toStrictEqual({
      text: 'Great', rating: 6, name: 'Ana', email: 'ana@example.com', page_url: 'http://localhost:3000/',
    })
  })

  it('draws the numeric rating 1 to 10 and the emoji rating as five faces', async () => {
    const numeric = await renderWidget({ ...FULL, rating_type: 'numeric' })
    clickStart(numeric)
    const cells = [...screen(numeric).querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((input) => input.value)
    const faces = await renderWidget({ ...FULL, rating_type: 'emoji' })
    clickStart(faces)

    expect(cells).toStrictEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'])
    expect(screen(faces).querySelectorAll('svg')).toHaveLength(5)
  })

  it('shows the placeholder, and the submit button text on the last question', async () => {
    const container = await renderWidget({ ...BASE, placeholder: 'Tell us…', submit_button_text: 'Send it' })
    clickStart(container)

    expect(screen(container).querySelector('textarea')?.placeholder).toBe('Tell us…')
    expect(nextButton(container).textContent).toBe('Send it')
  })

  it('shows the widget\'s own "Submit" for the untouched default button text, which the old widget never showed', async () => {
    const container = await renderWidget({ ...BASE, language: 'pl', submit_button_text: 'Submit Feedback' })
    clickStart(container)

    expect(nextButton(container).textContent).toBe('Wyślij')
  })

  it('requires the name and email it collects', async () => {
    const container = await renderWidget({ ...BASE, collect_email: true })
    clickStart(container)
    typeText(container, 'Great')
    clickNext(container)
    clickNext(container)

    const email = screen(container).querySelector<HTMLInputElement>('input[autocomplete="email"]')

    expect(errorText(container)).toBe('✕ Type an answer to continue.')
    expect([email?.getAttribute('aria-required'), email?.getAttribute('aria-invalid')]).toStrictEqual(['true', 'true'])
    expect(email?.labels?.[0]?.textContent).toBe('Email Required')
  })
})

describe("the widget's own words on a version 1 form", () => {
  it('speaks Polish on a Polish form, whatever the browser says, and says so on the container', async () => {
    document.body.dataset.browserLanguage = 'en-GB'
    const container = await renderWidget({ ...BASE, language: 'pl' })
    clickStart(container)

    expect([heading(container), nextButton(container).textContent]).toStrictEqual(['Powiedz nam więcej', 'Wyślij'])
    expect(container.getAttribute('lang')).toBe('pl')
  })

  it("speaks the browser's language when the form names none, and claims no language for the author's copy", async () => {
    document.body.dataset.browserLanguage = 'de-AT'
    const container = await renderWidget(BASE)
    clickStart(container)

    expect(heading(container)).toBe('Erzählen Sie uns mehr')
    expect(container.hasAttribute('lang')).toBe(false)
  })

  it.each(supportedLanguages)('starts with the label the editor preview shows for %s', async (language) => {
    expect(startButton(await renderWidget({ ...BASE, language })).textContent).toBe(WIDGET_START_LABEL[language])
  })

  it.each([
    ['pl', 'en-US'], ['', 'pl-PL'], ['', 'de_AT'], ['', 'xx'], ['tlh', 'ja-JP'], ['', ''], ['ZH', ''],
  ])('picks its language as the editor preview does (form %j, browser %j)', async (language, browser) => {
    document.body.dataset.browserLanguage = browser
    const shown = startButton(await renderWidget({ ...BASE, language })).textContent

    expect(shown).toBe(WIDGET_START_LABEL[widgetLanguage(language, browser)])
  })
})
