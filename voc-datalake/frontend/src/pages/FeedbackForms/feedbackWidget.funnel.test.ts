/**
 * The widget's part of the drop-off funnel (D6, lambda/api/feedback_form_handler.py "Beacons"): the beacons have their
 * own route, `…/events` (`eventsEndpoint`, its own throttle: never the submit route, whose limit is the responses').
 * The open is one `opened` beacon (once per page load per form, once the form is shown, never from the preview; the
 * config read carries no counter and writes nothing), and a respondent who started and leaves without submitting
 * sends a `left` beacon naming the furthest question reached: one per question reached, again only once they came
 * back and went further (never one per tab switch). Both go through navigator.sendBeacon (a keepalive fetch when it
 * refuses); never an answer, never a `left` after the response went, nothing from the preview.
 */
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backButton, calls, clickNext, clickStart, en, expectHeading, form, hidePage, leavePage, noticeText, renderPreview,
  renderWidget, resetWidgetPage, sentBeacons, submissions, submitted, typeText, widgetRoot,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

afterEach(resetWidgetPage)

const QUESTIONS: Question[] = [
  { id: 'q_text', type: 'open_text', headline: en('Anything else?'), required: false },
  { id: 'q_more', type: 'open_text', headline: en('More?'), required: false },
]
const TWO_STEPS = form(QUESTIONS)
const SUBMIT = 'https://api.example.com/feedback-forms/f1/submit'
const EVENTS = 'https://api.example.com/feedback-forms/f1/events'

/** A beacon's body as JSON, its random session id (24 hex digits) read as "S". */
function shown(body: Record<string, unknown>): string {
  return JSON.stringify(body).replace(/"session":"[a-f0-9]{24}"/, '"session":"S"')
}

/** The config reads so far (GETs), their addresses. */
function configReads(): string[] {
  return calls().filter((call) => call.method === 'GET').map((call) => call.url)
}

/** A field of a beacon's `event` (undefined when it has none). */
function eventField(sent: { body: Record<string, unknown> }, key: string): unknown {
  const event = sent.body.event
  return typeof event === 'object' && event !== null ? Reflect.get(event, key) : undefined
}

/** The beacons of one `kind` so far (`opened` or `left`). */
function beaconsOf(kind: string): Array<{ url: string, body: Record<string, unknown> }> {
  return sentBeacons().filter((sent) => eventField(sent, 'kind') === kind)
}

const leftBeacons = () => beaconsOf('left')

/** A beacon's session id. */
const sessionOf = (sent: { body: Record<string, unknown> }): unknown => eventField(sent, 'session')

describe('the open', () => {
  it('is one `opened` beacon on the events route once the form is shown; the config read counts nothing', async () => {
    await renderWidget(TWO_STEPS)

    expect(configReads()).toStrictEqual(['https://api.example.com/feedback-forms/f1/config'])
    expect(sentBeacons().map((sent) => [sent.url, shown(sent.body)])).toStrictEqual([
      [EVENTS, '{"event":{"kind":"opened","session":"S","revision":3}}'],
    ])
    expect(submissions()).toStrictEqual([])
  })

  it('is sent once per page load: a reload after "This form was updated" reads the config again without one', async () => {
    const container = await renderWidget(TWO_STEPS)
    document.body.dataset.submitStatus = '409'
    clickNext(container)
    clickNext(container)
    await waitFor(() => expect(noticeText(container)).toContain('This form was updated'))
    widgetRoot(container).querySelector<HTMLButtonElement>('.voc-notice-action')?.click()

    await waitFor(() => expect(configReads()).toStrictEqual([
      'https://api.example.com/feedback-forms/f1/config', 'https://api.example.com/feedback-forms/f1/config',
    ]))
    expect(beaconsOf('opened')).toHaveLength(1)
  })

  it("carries a test link's token, and the config read only the token", async () => {
    await renderWidget(TWO_STEPS, { test: 'tk_abc' })

    expect(configReads()).toStrictEqual(['https://api.example.com/feedback-forms/f1/config?test=tk_abc'])
    expect(sentBeacons().map((sent) => shown(sent.body))).toStrictEqual([
      '{"event":{"kind":"opened","session":"S","revision":3},"test":"tk_abc"}',
    ])
  })

  it('names no revision when the form serves none', async () => {
    await renderWidget(form(QUESTIONS, { revision: null }))

    expect(sentBeacons().map((sent) => shown(sent.body))).toStrictEqual(['{"event":{"kind":"opened","session":"S"}}'])
  })

  it("shares the visit's session with the response", async () => {
    const container = await renderWidget(TWO_STEPS)
    clickNext(container)
    clickNext(container)
    const body = await submitted()

    expect(beaconsOf('opened').map(sessionOf)).toStrictEqual([body.session])
  })

  it('is not sent for a form that is off, nor through a test link that no longer works', async () => {
    await renderWidget(form(QUESTIONS, { enabled: false }))
    await renderWidget(form(QUESTIONS, { test: { valid: false } }), { test: 'tk_old' })

    expect(sentBeacons()).toStrictEqual([])
  })

  it('is never counted, and nothing is ever beaconed, from the preview', () => {
    const container = renderPreview(TWO_STEPS)
    typeText(container, 'Hello')
    clickNext(container)
    leavePage()
    hidePage()

    expect([calls(), sentBeacons()]).toStrictEqual([[], []])
  })
})

describe('leaving without submitting', () => {
  it('sends one `left` beacon to the events route, naming the furthest question reached, with no answer', async () => {
    const container = await renderWidget(TWO_STEPS)
    typeText(container, 'secret answer')
    clickNext(container)
    backButton(container).click()
    leavePage()
    hidePage()
    leavePage()

    expect(leftBeacons().map((sent) => [sent.url, shown(sent.body)])).toStrictEqual([[
      EVENTS, '{"event":{"kind":"left","question_id":"q_more","session":"S","revision":3}}',
    ]])
    expect(JSON.stringify(leftBeacons())).not.toContain('secret answer')
    expect(submissions()).toStrictEqual([])
  })

  it('sends another `left` when the respondent came back and reached further, never one per tab switch', async () => {
    const container = await renderWidget(TWO_STEPS)
    typeText(container, 'x')
    hidePage()
    hidePage()
    clickNext(container)
    leavePage()
    hidePage()

    expect(leftBeacons().map((sent) => eventField(sent, 'question_id'))).toStrictEqual(['q_text', 'q_more'])
    expect(new Set(leftBeacons().map(sessionOf)).size).toBe(1)
  })

  it('sends it when the page goes hidden, which is what a phone fires', async () => {
    const container = await renderWidget(TWO_STEPS)
    typeText(container, 'x')
    hidePage()

    expect(leftBeacons().map((sent) => shown(sent.body))).toStrictEqual(['{"event":{"kind":"left","question_id":"q_text","session":"S","revision":3}}'])
  })

  it("carries the test link's token and nothing else", async () => {
    const container = await renderWidget(TWO_STEPS, { test: 'tk_abc' })
    typeText(container, 'x')
    leavePage()

    expect(leftBeacons().map((sent) => [Object.keys(sent.body), sent.body.test])).toStrictEqual([[['event', 'test'], 'tk_abc']])
  })

  it("sends the beacon's session with the response, so a respondent who left (a tab switch) and came back is no drop-off", async () => {
    const container = await renderWidget(TWO_STEPS)
    typeText(container, 'x')
    hidePage()
    clickNext(container)
    clickNext(container)
    const body = await submitted()

    expect(body.session).toMatch(/^[a-f0-9]{24}$/)
    expect(leftBeacons().map((sent) => JSON.stringify(sent.body.event))).toStrictEqual([
      JSON.stringify({ kind: 'left', question_id: 'q_text', session: body.session, revision: 3 }),
    ])
  })

  it('sends nothing once the response went', async () => {
    const container = await renderWidget(TWO_STEPS)
    typeText(container, 'x')
    clickNext(container)
    clickNext(container)
    await expectHeading(container, 'Thanks!')
    leavePage()

    expect([submissions().length, leftBeacons()]).toStrictEqual([1, []])
  })

  it('sends nothing for a respondent who never started (the welcome card, or a question left untouched)', async () => {
    await renderWidget(form(QUESTIONS, { welcome: { enabled: true, title: en('Hi') } }))
    leavePage()
    await renderWidget(TWO_STEPS)
    leavePage()

    expect(leftBeacons()).toStrictEqual([])
  })

  it('sends no beacon at all to a version 1 server (neither the open nor `left`)', async () => {
    const container = await renderWidget({ enabled: true, title: 'Hi', rating_enabled: false })
    clickStart(container)
    typeText(container, 'x')
    leavePage()

    expect(sentBeacons()).toStrictEqual([])
  })
})

describe('the beacons\' own route', () => {
  it('takes both beacons, while the response goes to the submit route and nothing else does', async () => {
    const container = await renderWidget(TWO_STEPS)
    typeText(container, 'x')
    hidePage()
    clickNext(container)
    clickNext(container)
    await submitted()

    expect(sentBeacons().map((sent) => [sent.url, eventField(sent, 'kind')])).toStrictEqual([
      [EVENTS, 'opened'], [EVENTS, 'left'],
    ])
    expect(calls().filter((call) => call.method === 'POST').map((call) => call.url)).toStrictEqual([SUBMIT])
  })

  it('is the `eventsEndpoint` option when given, the submit route staying `submitEndpoint`', async () => {
    const container = await renderWidget(TWO_STEPS, { eventsEndpoint: '/custom/f1/events', submitEndpoint: '/custom/f1/submit' })
    typeText(container, 'x')
    leavePage()

    expect(sentBeacons().map((sent) => sent.url)).toStrictEqual([
      'https://api.example.com/custom/f1/events', 'https://api.example.com/custom/f1/events',
    ])
  })

  it('is kept by the keepalive fetch when the browser refuses the beacon', async () => {
    document.body.dataset.beacon = 'refuse'
    const container = await renderWidget(TWO_STEPS)
    typeText(container, 'x')
    leavePage()

    expect(sentBeacons()).toStrictEqual([])
    expect(calls().filter((call) => call.method === 'POST').map((call) => [call.url, shown(call.body ?? {})])).toStrictEqual([
      [EVENTS, '{"event":{"kind":"opened","session":"S","revision":3}}'],
      [EVENTS, '{"event":{"kind":"left","question_id":"q_text","session":"S","revision":3}}'],
    ])
  })
})
