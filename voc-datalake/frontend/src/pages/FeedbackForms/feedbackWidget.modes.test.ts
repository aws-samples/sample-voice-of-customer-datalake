/**
 * What the widget takes from around it (UX spec §11.5, §11.7): hidden fields (the API page's `hf_<id>=`, the
 * `hidden` option, setHiddenFields; declared ids only, 200 characters), the respondent's language (D4: the link or
 * SDK, then the browser, then the primary), the test link's strip and token, the editor's preview (never sends),
 * and D15's assumed language. D6's funnel is feedbackWidget.funnel.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  calls, clickNext, en, expectHeading, form, handle, heading, nextButton, renderPreview, renderWidget,
  resetWidgetPage, screen, setHiddenFieldsForPage, submitted, typeText, widgetRoot,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

afterEach(resetWidgetPage)

const QUESTION: Question = { id: 'q_text', type: 'open_text', headline: { en: 'Anything else?', pl: 'Coś jeszcze?' }, required: false }
const HIDDEN = [{ id: 'user_id' }, { id: 'app_version' }]
const IFRAME = '/v1/feedback-forms/f1/iframe'

/** Answer nothing and press Submit; resolves with what was sent. */
async function send(container: HTMLElement): Promise<Record<string, unknown>> {
  clickNext(container)
  return submitted()
}

describe('hidden fields', () => {
  it('sends the declared values of the `hidden` option, each cut to 200 characters, and drops the others', async () => {
    const container = await renderWidget(form([QUESTION], { hidden_fields: HIDDEN }), {
      hidden: { user_id: 'u_1823', app_version: 'x'.repeat(250), plan: 'pro', screen: 'invoices' },
    })

    expect((await send(container)).hidden).toStrictEqual({ user_id: 'u_1823', app_version: 'x'.repeat(200) })
  })

  it("reads `hf_<id>=` from the API's own iframe page", async () => {
    const container = await renderWidget(form([QUESTION], { hidden_fields: HIDDEN }), {}, {
      path: `${IFRAME}?hf_user_id=qa-17&hf_app_version=5.0.3&hf_unknown=1`,
    })

    expect((await send(container)).hidden).toStrictEqual({ user_id: 'qa-17', app_version: '5.0.3' })
  })

  it("never reads a customer page's own address", async () => {
    const container = await renderWidget(form([QUESTION], { hidden_fields: HIDDEN }), {}, { path: '/checkout?hf_user_id=leak' })

    expect((await send(container)).hidden).toStrictEqual({})
  })

  it('takes what the iframe page hands over (`linkHidden`) once it has dropped a token from its address', async () => {
    const container = await renderWidget(form([QUESTION], { hidden_fields: HIDDEN }), {}, {
      beforeInit: "VoCFeedbackForm.linkHidden = { user_id: 'from-page', other: 'x' };",
    })

    expect((await send(container)).hidden).toStrictEqual({ user_id: 'from-page' })
  })

  it('takes setHiddenFields on the handle and on VoCFeedbackForm, the latest value winning', async () => {
    const container = await renderWidget(form([QUESTION], { hidden_fields: HIDDEN }), { hidden: { user_id: 'from-init' } })
    setHiddenFieldsForPage({ app_version: '5.0.4', user_id: 'from-page' })
    handle().setHiddenFields({ user_id: 'from-sdk', screen: 'undeclared' })

    expect((await send(container)).hidden).toStrictEqual({ user_id: 'from-sdk', app_version: '5.0.4' })
  })
})

describe("the respondent's language (D4)", () => {
  const BILINGUAL = form([QUESTION], { language: 'en', languages: ['en', 'pl'] })

  it('follows the `language` option when the form has it, and sends it', async () => {
    const container = await renderWidget(BILINGUAL, { language: 'pl' })

    expect([heading(container), nextButton(container).textContent]).toStrictEqual(['Coś jeszcze?', 'Wyślij'])
    expect((await send(container)).language).toBe('pl')
  })

  it("follows the API page's `lang=`, and puts the language on the page and the container", async () => {
    const container = await renderWidget(BILINGUAL, {}, { path: `${IFRAME}?lang=pl` })

    expect(heading(container)).toBe('Coś jeszcze?')
    expect([container.getAttribute('lang'), document.documentElement.getAttribute('lang'), document.title])
      .toStrictEqual(['pl', 'pl', 'Formularz opinii'])
  })

  it("takes the browser's first language the form has", async () => {
    document.body.dataset.browserLanguages = 'de-AT,pl-PL,en-US'
    const container = await renderWidget(BILINGUAL)

    expect(heading(container)).toBe('Coś jeszcze?')
  })

  it("falls back to the primary for a language the form doesn't have", async () => {
    document.body.dataset.browserLanguages = 'de-AT'
    const container = await renderWidget(BILINGUAL, { language: 'fr' })

    expect([heading(container), container.getAttribute('lang')]).toStrictEqual(['Anything else?', 'en'])
  })

  it('shows a missing translation in the primary language, marked with its language', async () => {
    const q: Question = { ...QUESTION, subheader: en('Optional, but it helps.') }
    const container = await renderWidget(form([q], { language: 'en', languages: ['en', 'pl'] }), { language: 'pl' })
    const sub = screen(container).querySelector('h2 + p, legend + p')

    expect([sub?.textContent, sub?.getAttribute('lang')]).toStrictEqual(['Optional, but it helps.', 'en'])
    expect(screen(container).querySelector('h2')?.hasAttribute('lang')).toBe(false)
  })

  it('never touches the html lang or title of a page that is not its own', async () => {
    await renderWidget(BILINGUAL, { language: 'pl' })

    expect([document.documentElement.hasAttribute('lang'), document.title]).toStrictEqual([false, ''])
  })
})

describe('the test link', () => {
  it('shows a TEST strip on every screen, asks the config with the token, and sends the token', async () => {
    const container = await renderWidget(form([QUESTION]), { test: 'tk_abc' })
    const strip = widgetRoot(container).querySelector('.voc-strip')

    expect([strip?.textContent, strip?.getAttribute('role')]).toStrictEqual(["TEST · Responses aren't counted", 'note'])
    expect(calls()[0]?.url).toBe('https://api.example.com/feedback-forms/f1/config?test=tk_abc')
    expect((await send(container)).test).toBe('tk_abc')
  })

  it("reads `test=` from the API's own page, and says Check only when the config does", async () => {
    const container = await renderWidget(form([QUESTION], { test: { valid: true, record: 'drop' } }), {}, { path: `${IFRAME}?test=tk_abc` })

    expect(widgetRoot(container).querySelector('.voc-strip')?.textContent).toBe('TEST · Nothing is saved')
  })

  it('opens a form that is Off (D2)', async () => {
    const container = await renderWidget(form([QUESTION], { enabled: false }), { test: 'tk_abc' })

    expect(heading(container)).toBe('Anything else?')
  })

  it('says the link no longer works when the config says its token is wrong', async () => {
    const container = await renderWidget(form([QUESTION], { test: { valid: false } }), { test: 'tk_old' })

    expect(widgetRoot(container).querySelector('[role="status"]')?.textContent).toBe('This test link no longer works.')
  })

  it('shows no strip and sends no token on the live link', async () => {
    const container = await renderWidget(form([QUESTION]))

    expect(widgetRoot(container).querySelector('.voc-strip')).toBeNull()
    expect(await send(container)).not.toHaveProperty('test')
  })
})

describe("the editor's preview", () => {
  const TWO = form([QUESTION, { id: 'q_more', type: 'open_text', headline: en('One more?'), required: false }], { enabled: false })

  it('shows "Preview · Nothing is sent", renders a form that is Off, and never fetches', () => {
    const container = renderPreview(TWO)

    expect(widgetRoot(container).querySelector('.voc-strip')?.textContent).toBe('Preview · Nothing is sent')
    expect([heading(container), calls()]).toStrictEqual(['Anything else?', []])
  })

  it('reaches the ending and says nothing was sent, without a request', async () => {
    const container = renderPreview(TWO)
    typeText(container, 'Hello')
    clickNext(container)
    clickNext(container)

    await expectHeading(container, 'Thanks!')
    expect(screen(container).querySelector('.voc-preview-done')?.textContent).toBe('Preview · nothing was sent')
    expect(calls()).toStrictEqual([])
  })

  it('follows a new draft on the same screen, keeping the answers', () => {
    const container = renderPreview(TWO)
    typeText(container, 'kept')
    handle().update(form([{ ...QUESTION, headline: en('Anything at all?') }], { enabled: false }))

    expect(heading(container)).toBe('Anything at all?')
    expect(screen(container).querySelector<HTMLInputElement>('.voc-input')?.value).toBe('kept')
  })

  it("starts a question afresh when a draft changes its type", () => {
    const container = renderPreview(TWO)
    typeText(container, 'kept')
    handle().update(form([{ ...QUESTION, type: 'multi_select', options: [{ code: 'a', label: en('Option A') }] }], { enabled: false }))

    expect(screen(container).querySelectorAll('input[type="checkbox"]')).toHaveLength(1)
    expect(screen(container).querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(false)
  })

  it('goes to a question, restarts, and changes language', () => {
    const container = renderPreview({ ...TWO, languages: ['en', 'pl'] })
    handle().goTo('q_more')
    const went = heading(container)
    handle().restart()
    const restarted = heading(container)
    handle().setLanguage('pl')

    expect([went, restarted, heading(container)]).toStrictEqual(['One more?', 'Anything else?', 'Coś jeszcze?'])
    expect(widgetRoot(container).querySelector('.voc-strip')?.textContent).toBe('Podgląd · Nic nie jest wysyłane')
  })

  it("takes postMessage from this page's own origin only", async () => {
    const container = renderPreview(TWO)
    const message = { type: 'voc-form-preview', action: 'goTo', questionId: 'q_more' }
    window.dispatchEvent(new MessageEvent('message', { data: message, origin: 'https://evil.example' }))
    const ignored = heading(container)
    window.dispatchEvent(new MessageEvent('message', { data: message, origin: window.location.origin }))

    expect(ignored).toBe('Anything else?')
    await expectHeading(container, 'One more?')
  })
})

describe('a version 1 form whose language is only assumed (D15)', () => {
  it("keeps the browser's words, answers in the assumed language, and claims no language", async () => {
    document.body.dataset.browserLanguages = 'de-AT'
    const container = await renderWidget(form([QUESTION], { language_assumed: true }))

    expect([nextButton(container).textContent, container.hasAttribute('lang')]).toStrictEqual(['Senden', false])
    expect((await send(container)).language).toBe('en')
  })
})
