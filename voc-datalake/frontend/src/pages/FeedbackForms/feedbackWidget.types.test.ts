/**
 * The widget's other question types (UX spec §11.3): open text (short with its input types, long, the counter),
 * rating (stars, numbers, faces), NPS 0–10, CSAT 1–5 faces and CES 1–7 with their end labels, statement and its
 * https-only link, consent, and contact info; each with its checks and the answer it sends (response v2).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  accessibleText, answersOf, clickNext, en, errorText, form, heading, pickByKey, renderWidget,
  resetWidgetPage, screen, submitted, typeText,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

afterEach(resetWidgetPage)

/** Press Next on the form's one question `id`; resolves with the answers it sent. */
async function sent(container: HTMLElement): Promise<Record<string, unknown>> {
  clickNext(container)
  return answersOf(await submitted())
}

function text(extra: Record<string, unknown> = {}): Question {
  return { id: 'q_text', type: 'open_text', headline: en('Anything else?'), required: true, long: false, input_type: 'text', ...extra }
}

/** The accessible names of the screen's radios, in order. */
function radioNames(container: HTMLElement): string[] {
  return [...screen(container).querySelectorAll('input[type="radio"]')].map((input) => accessibleText(input.closest('label') ?? input))
}

describe('open text', () => {
  it('is a field labelled by the question, with its placeholder as a hint only', async () => {
    const container = await renderWidget(form([text({ placeholder: en('e.g. Excel export') })]))
    const field = screen(container).querySelector<HTMLInputElement>('.voc-input')

    expect(field?.getAttribute('aria-labelledby')).toBe(screen(container).querySelector('h2')?.id)
    expect([field?.placeholder, field?.type]).toStrictEqual(['e.g. Excel export', 'text'])
  })

  it('sends the trimmed text', async () => {
    const container = await renderWidget(form([text()]))
    typeText(container, '  Exports are slow  ')

    expect(await sent(container)).toStrictEqual({ q_text: 'Exports are slow' })
  })

  it('asks for an answer when it is required and blank, and sends nothing for a blank optional one', async () => {
    const container = await renderWidget(form([text()]))
    typeText(container, '   ')
    clickNext(container)
    const blank = errorText(container)
    const optional = await renderWidget(form([text({ required: false })]))

    expect(blank).toBe('✕ Type an answer to continue.')
    expect(await sent(optional)).toStrictEqual({})
  })

  it.each([
    ['email', 'email', 'email', 'not-an-email', 'Enter a valid email address.', 'ana@example.com'],
    ['number', 'text', 'decimal', '12,5', 'Enter a number.', '-12.5'],
    ['phone', 'tel', 'tel', 'call me', 'Enter a valid phone number.', '+48 22 123 45 67'],
    ['url', 'url', 'url', 'example', 'Enter a valid web address.', 'https://example.com/a'],
  ])('as %s is an <input type=%s inputmode=%s> that checks the answer', async (inputType, type, inputmode, bad, words, good) => {
    const container = await renderWidget(form([text({ input_type: inputType })]))
    const field = screen(container).querySelector('.voc-input')
    typeText(container, bad)
    clickNext(container)
    const refused = errorText(container)
    typeText(container, good)

    expect([field?.getAttribute('type'), field?.getAttribute('inputmode')]).toStrictEqual([type, inputmode])
    expect(refused).toBe(`✕ ${words}`)
    expect(await sent(container)).toStrictEqual({ q_text: good })
  })

  it('is a textarea when long, with the default placeholder', async () => {
    const container = await renderWidget(form([text({ long: true })]))
    const field = screen(container).querySelector('textarea')

    expect([field?.rows, field?.placeholder]).toStrictEqual([3, 'Type your answer here…'])
  })

  it('stops at its limit and counts from 80 % of it', async () => {
    const container = await renderWidget(form([text({ long: true, max_chars: 10 })]))
    const field = screen(container).querySelector('textarea')
    const counter = screen(container).querySelector(`#${field?.getAttribute('aria-describedby')?.split(' ')[0] ?? 'x'}`)
    typeText(container, 'abcdefg')
    const under = counter?.textContent
    typeText(container, 'abcdefgh')

    expect([field?.maxLength, under]).toStrictEqual([10, ''])
    expect(counter?.textContent).toBe('8 / 10')
  })
})

describe('rating, NPS, CSAT and CES', () => {
  const RATING: Question = {
    id: 'q_rate', type: 'rating', headline: en('How was it?'), required: true, scale: 'star', range: 5,
    lower_label: en('Awful'), upper_label: en('Superb'),
  }

  it('draws stars as a radio group named by the question, each "n of max" and the end words at the ends', async () => {
    const container = await renderWidget(form([RATING]))

    expect(screen(container).querySelector('[role="radiogroup"]')?.getAttribute('aria-labelledby')).toBe(screen(container).querySelector('h2')?.id)
    expect(radioNames(container)).toStrictEqual(['1 of 5, Awful', '2 of 5', '3 of 5', '4 of 5', '5 of 5, Superb'])
  })

  it('always shows the end words under the scale (never hover-only)', async () => {
    const container = await renderWidget(form([RATING]))

    expect(screen(container).querySelector('.voc-scale-ends')?.textContent).toBe('AwfulSuperb')
  })

  it('sends the picked number', async () => {
    const container = await renderWidget(form([RATING]))
    pickByKey(container, '4 of 5')

    expect(await sent(container)).toStrictEqual({ q_rate: 4 })
  })

  it('asks for an answer when nothing is picked', async () => {
    const container = await renderWidget(form([RATING]))
    clickNext(container)

    expect(errorText(container)).toBe('✕ Choose an answer to continue.')
  })

  it.each([3, 4, 7, 10])('draws a %i-point number scale', async (range) => {
    const container = await renderWidget(form([{ ...RATING, scale: 'number', range, lower_label: undefined, upper_label: undefined }]))

    expect(radioNames(container).at(-1)).toBe(`${range} of ${range}`)
  })

  it.each([
    [3, ['Bad', 'Okay', 'Good']], [4, ['Very bad', 'Bad', 'Good', 'Very good']],
    [5, ['Very bad', 'Bad', 'Okay', 'Good', 'Very good']],
  ])('draws %i faces (SVG, not emoji) with their words', async (range, words) => {
    const container = await renderWidget(form([{ ...RATING, scale: 'smiley', range, lower_label: undefined, upper_label: undefined }]))

    expect(screen(container).querySelectorAll('svg')).toHaveLength(range)
    expect(radioNames(container)).toStrictEqual(words.map((word, i) => `${word} (${i + 1} of ${range})`))
  })

  it('draws NPS as 11 cells from 0 to 10 on one row, and sends 0', async () => {
    const container = await renderWidget(form([{ id: 'q_nps', type: 'nps', headline: en('Recommend us?'), required: true }]))
    const values = [...screen(container).querySelectorAll<HTMLInputElement>('input[type="radio"]')].map((input) => Number(input.value))
    pickByKey(container, '0 of 10')

    expect(values).toStrictEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(screen(container).querySelector<HTMLElement>('.voc-scale')?.style.flexWrap).toBe('nowrap')
    expect(await sent(container)).toStrictEqual({ q_nps: 0 })
  })

  it('draws CSAT as five faces and CES as seven cells', async () => {
    const csat = await renderWidget(form([{ id: 'q_csat', type: 'csat', headline: en('Satisfied?'), required: true }]))
    const faces = screen(csat).querySelectorAll('svg').length
    const ces = await renderWidget(form([{ id: 'q_ces', type: 'ces', headline: en('Easy?'), required: true }]))
    pickByKey(ces, '7 of 7')

    expect([faces, radioNames(ces).length]).toStrictEqual([5, 7])
    expect(await sent(ces)).toStrictEqual({ q_ces: 7 })
  })
})

describe('statement', () => {
  const STATEMENT: Question = {
    id: 'q_info', type: 'statement', headline: en('We are moving'), subheader: en('The new address is live.'),
    required: false, cta: { label: en('Learn more'), url: 'https://example.com/news' },
  }

  it('opens its https link in a new tab without the opener, and says so to screen readers', async () => {
    const container = await renderWidget(form([STATEMENT]))
    const link = screen(container).querySelector('a')

    expect([link?.href, link?.target, link?.rel]).toStrictEqual(['https://example.com/news', '_blank', 'noopener noreferrer'])
    expect(link?.textContent).toBe('Learn more ↗ (opens in a new tab)')
  })

  it('takes no answer and Next moves on', async () => {
    const container = await renderWidget(form([STATEMENT, text()]))
    clickNext(container)

    expect(heading(container)).toBe('Anything else?')
  })

  it('sends no answer for itself', async () => {
    const container = await renderWidget(form([STATEMENT]))

    expect(await sent(container)).toStrictEqual({})
  })
})

describe('consent', () => {
  const CONSENT: Question = {
    id: 'q_ok', type: 'consent', headline: en('Before you go on'), required: true, label: en('Yes, you may contact me'),
  }

  it('is one large checkbox row that must be ticked when required, and sends true', async () => {
    const container = await renderWidget(form([CONSENT]))
    clickNext(container)
    const refused = errorText(container)
    pickByKey(container, 'Yes, you may contact me')

    expect(screen(container).querySelector<HTMLElement>('.voc-opt')?.style.minHeight).toBe('48px')
    expect(refused).toBe('✕ Tick the box to continue.')
    expect(await sent(container)).toStrictEqual({ q_ok: true })
  })

  it('answers false when optional and left unticked', async () => {
    const container = await renderWidget(form([{ ...CONSENT, required: false }]))

    expect(await sent(container)).toStrictEqual({ q_ok: false })
  })
})

describe('contact info', () => {
  const CONTACT: Question = {
    id: 'q_contact', type: 'contact_info', headline: en('How can we reach you?'), required: true,
    fields: {
      name: { show: true, required: false }, email: { show: true, required: true },
      phone: { show: false, required: false }, company: { show: true, required: false },
    },
  }

  it('shows the shown fields only, each labelled above it, with its autocomplete', async () => {
    const container = await renderWidget(form([CONTACT]))
    const fields = [...screen(container).querySelectorAll('input')]

    expect(fields.map((input) => input.getAttribute('autocomplete'))).toStrictEqual(['name', 'email', 'organization'])
    expect(fields.map((input) => input.labels?.[0]?.textContent)).toStrictEqual(['Name', 'Email Required', 'Company'])
  })

  it('requires its required field and checks the email address', async () => {
    const container = await renderWidget(form([CONTACT]))
    typeText(container, 'Ana', 'input[autocomplete="name"]')
    clickNext(container)
    const missing = errorText(container)
    typeText(container, 'ana@', 'input[autocomplete="email"]')
    clickNext(container)

    expect([missing, errorText(container)]).toStrictEqual(['✕ Type an answer to continue.', '✕ Enter a valid email address.'])
    expect(document.activeElement).toBe(screen(container).querySelector('input[autocomplete="email"]'))
  })

  it('sends the filled fields only', async () => {
    const container = await renderWidget(form([CONTACT]))
    typeText(container, 'ana@example.com', 'input[autocomplete="email"]')
    typeText(container, ' Example Ltd ', 'input[autocomplete="organization"]')

    expect(await sent(container)).toStrictEqual({ q_contact: { email: 'ana@example.com', company: 'Example Ltd' } })
  })
})
