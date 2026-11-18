/**
 * The widget's step engine (contract "Rule"; UX spec §11.1): the welcome card, questions in order, logic (the
 * first matching rule wins, forward only, otherwise the next question), several endings, Back, progress, and the
 * path the answers are sent for (a question the logic skipped sends nothing, as the server checks).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  answersOf, backButton, clickNext, clickStart, en, expectHeading, form, heading, nextButton, pickByKey, renderWidget,
  resetWidgetPage, screen, submitted, typeText,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

afterEach(resetWidgetPage)

function open(id: string, title: string, extra: Record<string, unknown> = {}): Question {
  return { id, type: 'open_text', headline: en(title), required: false, long: false, input_type: 'text', ...extra }
}

const ENDINGS = [
  { id: 'end_thanks', title: en('Thanks!'), description: en('We read every answer.') },
  { id: 'end_call', title: en('We will call you'), button: { label: en('Our status page'), url: 'https://status.example.com/' } },
]

/** "Otherwise go to `target`" as the editor stores it on an optional question (UX spec §5.3). */
function otherwise(target: string): Array<Record<string, unknown>> {
  return [{ when: { op: 'submitted' }, then: { jump_to: target } }, { when: { op: 'skipped' }, then: { jump_to: target } }]
}

/** NPS, then a passive, a detractor and a promoter follow-up, and a last question everyone gets. */
const NPS_FLOW = [
  {
    id: 'q_nps', type: 'nps', headline: en('Recommend us?'), required: true, logic: [
      { when: { op: 'lte', value: 6 }, then: { jump_to: 'q_low' } },
      { when: { op: 'gte', value: 9 }, then: { jump_to: 'q_high' } },
    ],
  },
  open('q_passive', 'What would make it a 10?', { logic: otherwise('q_last') }),
  open('q_low', 'What went wrong?', { logic: otherwise('q_last') }),
  open('q_high', 'What do you love?'),
  open('q_last', 'Anything else?'),
]

/** The headings of the next `steps` screens, pressing Next on each (answering nothing), up to the submission. */
async function walk(container: HTMLElement, steps: number): Promise<string[]> {
  const seen = Array.from({ length: steps }, () => {
    const shown = heading(container)
    clickNext(container)
    return shown
  })
  await submitted()
  return seen
}

describe('questions in order', () => {
  it('goes through the questions in order and ends on the first ending', async () => {
    const container = await renderWidget(form([open('q_a', 'First'), open('q_b', 'Second')], { endings: ENDINGS }))
    const seen = await walk(container, 2)

    expect(seen).toStrictEqual(['First', 'Second'])
    await expectHeading(container, 'Thanks!')
    expect(screen(container).textContent).toContain('We read every answer.')
  })

  it('sends the ending reached, the revision and the language', async () => {
    const container = await renderWidget(form([open('q_a', 'First')], { endings: ENDINGS }))
    clickNext(container)
    const body = await submitted()

    expect([body.ending_id, body.form_revision, body.language]).toStrictEqual(['end_thanks', 3, 'en'])
  })

  it('reads "Submit" on the last question and "Next" before it', async () => {
    const container = await renderWidget(form([open('q_a', 'First'), open('q_b', 'Second')]))
    const first = nextButton(container).textContent
    clickNext(container)

    expect([first, nextButton(container).textContent]).toStrictEqual(['Next', 'Submit'])
  })

  it("uses a question's own button label", async () => {
    const container = await renderWidget(form([open('q_a', 'First', { button_label: en('Continue') }), open('q_b', 'Second')]))

    expect(nextButton(container).textContent).toBe('Continue')
  })
})

describe('logic', () => {
  it.each([
    ['3 of 10', ['Recommend us?', 'What went wrong?', 'Anything else?']],
    ['10 of 10', ['Recommend us?', 'What do you love?', 'Anything else?']],
    ['8 of 10', ['Recommend us?', 'What would make it a 10?', 'Anything else?']],
  ])('routes an NPS of %s through its rules (first match wins, otherwise the next question)', async (score, path) => {
    const container = await renderWidget(form(NPS_FLOW))
    pickByKey(container, score)
    clickNext(container)
    const seen = await walk(container, path.length - 1)

    expect([path[0], ...seen]).toStrictEqual(path)
  })

  it('lets the first matching rule win when several match', async () => {
    const q: Question = {
      id: 'q_score', type: 'rating', headline: en('Score?'), required: true, scale: 'number', range: 5, logic: [
        { when: { op: 'gte', value: 3 }, then: { jump_to: 'q_c' } },
        { when: { op: 'equals', value: 4 }, then: { jump_to: 'q_b' } },
      ],
    }
    const container = await renderWidget(form([q, open('q_b', 'B'), open('q_c', 'C')]))
    pickByKey(container, '4 of 5')
    clickNext(container)

    expect(heading(container)).toBe('C')
  })

  it('ends on the ending a rule names, and sends it', async () => {
    const q: Question = {
      id: 'q_pick', type: 'single_select', headline: en('Call you?'), required: true,
      options: [{ code: 'yes', label: en('Yes') }, { code: 'no', label: en('No') }],
      logic: [{ when: { op: 'equals', value: 'yes' }, then: { jump_to: 'end_call' } }],
    }
    const container = await renderWidget(form([q, open('q_more', 'More?')], { endings: ENDINGS }))
    pickByKey(container, 'Yes')
    const label = nextButton(container).textContent
    clickNext(container)
    const body = await submitted()

    expect(label).toBe('Submit')
    expect(body.ending_id).toBe('end_call')
    await expectHeading(container, 'We will call you')
  })

  it("opens an ending's https button in a new tab", async () => {
    const container = await renderWidget(form([open('q_a', 'First')], { endings: [ENDINGS[1]] }))
    clickNext(container)
    await expectHeading(container, 'We will call you')
    const link = screen(container).querySelector('a')

    expect([link?.href, link?.target, link?.rel]).toStrictEqual(['https://status.example.com/', '_blank', 'noopener noreferrer'])
  })

  it('never jumps backwards: a rule naming an earlier question goes on to the next', async () => {
    const back = open('q_b', 'B', { logic: [{ when: { op: 'skipped' }, then: { jump_to: 'q_a' } }] })
    const container = await renderWidget(form([open('q_a', 'A'), back, open('q_c', 'C')]))
    clickNext(container)
    clickNext(container)

    expect(heading(container)).toBe('C')
  })

  it.each([
    ['includes_any', ['b', 'x'], ['Option A', 'Option B'], 'Jumped'],
    ['includes_all', ['a', 'b'], ['Option A'], 'Next'],
    ['includes_all', ['a', 'b'], ['Option A', 'Option B'], 'Jumped'],
  ])('matches a multiple choice with %s %j when %j are ticked: %s', async (op, value, ticked, where) => {
    const q: Question = {
      id: 'q_multi', type: 'multi_select', headline: en('Which?'), required: true,
      options: [{ code: 'a', label: en('Option A') }, { code: 'b', label: en('Option B') }, { code: 'x', label: en('Option X') }],
      logic: [{ when: { op, value }, then: { jump_to: 'q_jumped' } }],
    }
    const container = await renderWidget(form([q, open('q_next', 'Next'), open('q_jumped', 'Jumped')]))
    for (const words of ticked) pickByKey(container, words)
    clickNext(container)

    expect(heading(container)).toBe(where)
  })

  it('matches an open text by its words, whatever their case', async () => {
    const q = open('q_code', 'Your code?', { logic: [{ when: { op: 'equals', value: 'VIP' }, then: { jump_to: 'q_vip' } }] })
    const container = await renderWidget(form([q, open('q_next', 'Next'), open('q_vip', 'Welcome back')]))
    typeText(container, 'vip')
    clickNext(container)

    expect(heading(container)).toBe('Welcome back')
  })

  it('treats a statement as answered, so its rule is a plain jump', async () => {
    const statement: Question = {
      id: 'q_info', type: 'statement', headline: en('Note'), required: false,
      logic: [{ when: { op: 'submitted' }, then: { jump_to: 'q_c' } }],
    }
    const container = await renderWidget(form([statement, open('q_b', 'B'), open('q_c', 'C')]))
    clickNext(container)

    expect(heading(container)).toBe('C')
  })

  it('treats an unticked optional consent as not given ("skipped")', async () => {
    const consent: Question = {
      id: 'q_ok', type: 'consent', headline: en('Contact you?'), required: false, label: en('Yes, contact me'),
      logic: [{ when: { op: 'skipped' }, then: { jump_to: 'end_thanks' } }],
    }
    const container = await renderWidget(form([consent, open('q_email', 'Your email?')]))
    clickNext(container)
    const body = await submitted()

    expect(answersOf(body)).toStrictEqual({ q_ok: false })
    expect(body.ending_id).toBe('end_thanks')
  })
})

describe('Back and the path', () => {
  it('goes back to the previous question with its answer kept', async () => {
    const container = await renderWidget(form([open('q_a', 'First'), open('q_b', 'Second')]))
    typeText(container, 'kept')
    clickNext(container)
    backButton(container).click()

    expect(heading(container)).toBe('First')
    expect(screen(container).querySelector<HTMLInputElement>('.voc-input')?.value).toBe('kept')
  })

  it('goes back along the path taken, not the form order', async () => {
    const container = await renderWidget(form(NPS_FLOW))
    pickByKey(container, '10 of 10')
    clickNext(container)
    clickNext(container)
    backButton(container).click()
    const first = heading(container)
    backButton(container).click()

    expect([first, heading(container)]).toStrictEqual(['What do you love?', 'Recommend us?'])
  })

  it('sends no answer for a question the final path skips, even one answered before going back', async () => {
    const container = await renderWidget(form(NPS_FLOW))
    pickByKey(container, '3 of 10')
    clickNext(container)
    typeText(container, 'Too slow')
    backButton(container).click()
    pickByKey(container, '10 of 10')
    clickNext(container)
    typeText(container, 'The reports')
    clickNext(container)
    clickNext(container)

    expect(answersOf(await submitted())).toStrictEqual({ q_nps: 10, q_high: 'The reports' })
  })
})

describe('progress', () => {
  /** The progress bar's words. */
  function progress(container: HTMLElement): string | null {
    return container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuetext') ?? null
  }

  it('counts the longest path left, and shrinks when the logic skips ahead', async () => {
    const q: Question = {
      id: 'q_score', type: 'rating', headline: en('Score?'), required: true, scale: 'number', range: 5,
      logic: [{ when: { op: 'equals', value: 1 }, then: { jump_to: 'q_d' } }],
    }
    const container = await renderWidget(form([q, open('q_b', 'B'), open('q_c', 'C'), open('q_d', 'D')]))
    const first = progress(container)
    pickByKey(container, '1 of 5')
    clickNext(container)

    expect([first, progress(container)]).toStrictEqual(['Question 1 of 4', 'Question 2 of 2'])
    expect(container.querySelector('.voc-live')?.textContent).toBe('Question 2 of 2')
  })

  it('counts an "Otherwise" as the only way on (the next question is never reached by no match)', async () => {
    const container = await renderWidget(form(NPS_FLOW))

    expect(progress(container)).toBe('Question 1 of 3')
  })

  it('is hidden on the welcome card and the ending', async () => {
    const container = await renderWidget(form([open('q_a', 'First')], { welcome: { enabled: true, title: en('Hi') } }))
    const onWelcome = container.querySelector<HTMLElement>('[role="progressbar"]')?.hidden
    clickStart(container)
    const onQuestion = container.querySelector<HTMLElement>('[role="progressbar"]')?.hidden
    clickNext(container)
    await expectHeading(container, 'Thanks!')

    expect([onWelcome, onQuestion, container.querySelector<HTMLElement>('[role="progressbar"]')?.hidden]).toStrictEqual([true, false, true])
  })
})

describe('the welcome card', () => {
  it('shows its title, description and button label, then the first question', async () => {
    const welcome = { enabled: true, title: en('Two minutes?'), description: en('Help us improve.'), button_label: en("Let's go") }
    const container = await renderWidget(form([open('q_a', 'First')], { welcome }))
    const shown = [heading(container), screen(container).querySelector('p')?.textContent, screen(container).querySelector('.voc-start')?.textContent]
    clickStart(container)

    expect(shown).toStrictEqual(['Two minutes?', 'Help us improve.', "Let's go"])
    expect(heading(container)).toBe('First')
  })

  it('is skipped when off: the form opens on its first question', async () => {
    const container = await renderWidget(form([open('q_a', 'First')], { welcome: { enabled: false, title: en('Hi') } }))

    expect(heading(container)).toBe('First')
  })

  it('ends on "Thank you!" when the form has no ending of its own', async () => {
    const container = await renderWidget(form([open('q_a', 'First')], { endings: [] }))
    clickNext(container)
    const body = await submitted()

    await expectHeading(container, 'Thank you!')
    expect(body).not.toHaveProperty('ending_id')
  })
})
