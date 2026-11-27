/**
 * Recall in the widget (docs/feedback-forms.md "Recall"): `{{id}}` or `{{id|fallback}}` in a recall text
 * (the welcome's title and description, a question's headline and subheader, an ending's title and description) shows
 * a declared hidden field's value, or an earlier question's answer on the respondent's path (a score's number, a
 * single choice's label in their language), else the fallback, else nothing with the text tidied around the gap: the
 * `render` cases of schemas/form-recall-cases.json, which the builder's model/recall.ts follows too. Values are text,
 * never markup, and only the form's own fields are looked up.
 */
import { afterEach, describe, expect, it } from 'vitest'
import recallCases from '../../../../schemas/form-recall-cases.json'
import {
  backButton, choice, clickNext, clickStart, en, expectHeading, form, heading, openText, pickByKey, renderWidget,
  resetWidgetPage, screen, typeText,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

afterEach(resetWidgetPage)

const IFRAME = '/v1/feedback-forms/f1/iframe'
const NPS: Question = { id: 'q_nps', type: 'nps', headline: en('How likely are you to recommend us?'), required: true }
const PICK: Question = {
  id: 'q_pick', type: 'single_select', headline: en('What mattered most?'), required: true, display: 'list',
  options: [{ code: 'price', label: { en: 'Price', pl: 'Cena' } }, { code: 'support', label: { en: 'Support', pl: 'Wsparcie' } }],
  other: { enabled: true },
}
const hiddenOf = (values: Readonly<Record<string, string | undefined>>) => Object.keys(values).map((id) => ({ id }))

describe('the shared render cases (schemas/form-recall-cases.json)', () => {
  it.each(recallCases.render)('shows "$text" with $values as "$output"', async ({ text, values, output }) => {
    const questions = [{ ...openText('q_a', ''), headline: en(text) }, openText('q_b', 'Next')]
    const container = await renderWidget(form(questions, { hidden_fields: hiddenOf(values) }), { hidden: values })

    expect(heading(container)).toBe(output)
  })
})

describe('what a placeholder shows', () => {
  it("shows a link's hidden value in the welcome, a subheader and a headline, and the fallback without one", async () => {
    const config = form([openText('q_a', 'How was {{event}} for {{team|your team}}?', { subheader: en('About {{event}}.') })], {
      hidden_fields: [{ id: 'event' }, { id: 'team' }],
      welcome: { enabled: true, title: en('Welcome to {{event}}!'), description: en('Hi {{team}}, two minutes.') },
    })
    const container = await renderWidget(config, {}, { path: `${IFRAME}?hf_event=the%20Lisbon%20workshop` })
    const welcome = [heading(container), screen(container).querySelector('p')?.textContent]
    clickStart(container)

    expect(welcome).toStrictEqual(['Welcome to the Lisbon workshop!', 'Hi, two minutes.'])
    expect([heading(container), screen(container).querySelector('legend + p')?.textContent])
      .toStrictEqual(['How was the Lisbon workshop for your team?', 'About the Lisbon workshop.'])
  })

  it('recalls an earlier NPS and a single choice into a later headline and into the ending', async () => {
    const why = openText('q_why', 'You gave {{q_nps}} and chose {{q_pick}}. Why?')
    const container = await renderWidget(form([NPS, PICK, why], {
      endings: [{ id: 'end_thanks', title: en('Thanks for the {{q_nps}}!'), description: en('{{q_pick}} it is.') }],
    }))
    pickByKey(container, '9 of 10')
    clickNext(container)
    pickByKey(container, 'Support')
    clickNext(container)
    const later = heading(container)
    typeText(container, 'Fast answers')
    clickNext(container)
    await expectHeading(container, 'Thanks for the 9!')

    expect(later).toBe('You gave 9 and chose Support. Why?')
    expect(screen(container).querySelector('h2 + p')?.textContent).toBe('Support it is.')
  })

  it("shows a single choice's label in the respondent's language, and never an Other text", async () => {
    const twoLanguages = { languages: ['en', 'pl'] }
    const why = openText('q_why', 'Why {{q_pick|that}}?')
    const polish = await renderWidget(form([PICK, why], twoLanguages), { language: 'pl' })
    pickByKey(polish, 'Cena')
    clickNext(polish)
    const other = await renderWidget(form([PICK, why]))
    pickByKey(other, 'Other')
    typeText(other, 'My own words', '.voc-other-input')
    clickNext(other)

    expect([heading(polish), heading(other)]).toStrictEqual(['Why Cena?', 'Why that?'])
  })

  it('never recalls a question placed after the text, nor one the respondent left off their path', async () => {
    const jump = { ...NPS, logic: [{ when: { op: 'gte', value: 9 }, then: { jump_to: 'q_last' } }] }
    const last = openText('q_last', 'You chose {{q_pick|nothing}}')
    const container = await renderWidget(form([{ ...jump, headline: en('Before {{q_pick}} comes this') }, PICK, last]))
    const before = heading(container)
    pickByKey(container, '5 of 10')
    clickNext(container)
    pickByKey(container, 'Price')
    clickNext(container)
    const onPath = heading(container)
    backButton(container).click()
    backButton(container).click()
    pickByKey(container, '10 of 10')
    clickNext(container)

    expect([before, onPath, heading(container)]).toStrictEqual(['Before comes this', 'You chose Price', 'You chose nothing'])
  })

  it('never fills a placeholder outside a recall text: an option label and a button show it as written', async () => {
    const pick = { ...PICK, options: [{ code: 'a', label: en('Go to {{event}}') }], button_label: en('On to {{event}}') }
    const container = await renderWidget(form([pick], { hidden_fields: [{ id: 'event' }] }), { hidden: { event: 'Lisbon' } })

    expect(choice(container, 'Go to {{event}}').value).toBe('a')
    expect(screen(container).querySelector('.voc-next')?.textContent).toBe('On to {{event}}')
  })
})

describe('recall is safe', () => {
  it('puts a value in as text: markup in a hidden value creates no element', async () => {
    const value = '<img src=x onerror="document.body.dataset.hacked=1"><b>Lisbon</b>'
    const container = await renderWidget(form([openText('q_a', 'How was {{event}}?')], { hidden_fields: [{ id: 'event' }] }),
      { hidden: { event: value } })

    expect(heading(container)).toBe(`How was ${value}?`)
    expect([screen(container).querySelector('img, b'), document.body.dataset.hacked]).toStrictEqual([null, undefined])
  })

  it("looks an id up only among the form's own fields: an object's machinery and an undeclared value show nothing", async () => {
    const container = await renderWidget(form([openText('q_a', 'A {{constructor}} B {{toString|z}} C {{secret}}.')]),
      { hidden: { secret: 'leak', toString: 'no' } })

    expect(heading(container)).toBe('A B z C.')
  })

  it('shows an unknown placeholder of a form saved before 7.06.00 as nothing, or its fallback', async () => {
    const container = await renderWidget(form([openText('q_a', 'Hello {{customer}}, rate {{product|our app}}')]))

    expect(heading(container)).toBe('Hello, rate our app')
  })
})
