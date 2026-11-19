/**
 * The widget's single and multiple choice (UX spec §11.3, §11.4): list, dropdown and chips, the Auto rule counting
 * Other and None, Other's text box, the exclusive None, min and max, shuffle once per respondent, and the answer
 * each sends (response v2: `{code}` or `{other}`; `{codes, other?}`).
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  answersOf, backButton, choice, choiceWords, clickNext, en, errorText, form, heading, pickByKey, press, renderWidget,
  focused, resetWidgetPage, screen, selectValue, submitted, typeText,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

afterEach(resetWidgetPage)

/** `count` options a, b, c… labelled "Option A"… */
function options(count: number): Array<{ code: string, label: Record<string, string> }> {
  return Array.from({ length: count }, (_, i) => {
    const letter = String.fromCodePoint(97 + i)
    return { code: letter, label: en(`Option ${letter.toUpperCase()}`) }
  })
}

function single(extra: Record<string, unknown> = {}): Question {
  return { id: 'q_why', type: 'single_select', headline: en('Why are you leaving?'), required: true, options: options(3), ...extra }
}

function multi(extra: Record<string, unknown> = {}): Question {
  return { id: 'q_what', type: 'multi_select', headline: en('What do you use?'), required: true, options: options(4), ...extra }
}

const OTHER = { enabled: true, label: en('Another reason'), placeholder: en('Tell us which') }

/** Press Next on the form's one question; resolves with the answer it sent for it. */
async function answer(container: HTMLElement): Promise<unknown> {
  clickNext(container)
  const answers = answersOf(await submitted())
  return answers.q_why ?? answers.q_what
}

describe('single choice as a list', () => {
  it('is a radio group of full-width rows (48 px), named by the question', async () => {
    const container = await renderWidget(form([single()]))
    const group = screen(container).querySelector('[role="radiogroup"]')

    expect(group?.getAttribute('aria-labelledby')).toBe(screen(container).querySelector('h2')?.id)
    expect(choiceWords(container)).toStrictEqual(['Option A', 'Option B', 'Option C'])
    expect(screen(container).querySelector<HTMLElement>('.voc-opt')?.style.minHeight).toBe('48px')
  })

  it('sends the code of the picked option', async () => {
    const container = await renderWidget(form([single()]))
    pickByKey(container, 'Option B')

    expect(await answer(container)).toStrictEqual({ code: 'b' })
  })

  it('asks for an answer when it is required and none is picked', async () => {
    const container = await renderWidget(form([single()]))
    clickNext(container)

    expect(errorText(container)).toBe('✕ Choose an answer to continue.')
  })

  it('shows Other\'s text box once Other is picked, requires its text, and sends it as {other}', async () => {
    const container = await renderWidget(form([single({ other: OTHER })]))
    const box = screen(container).querySelector<HTMLElement>('.voc-other')
    const hiddenAtFirst = box?.hidden
    pickByKey(container, 'Another reason')
    clickNext(container)
    const missing = errorText(container)
    typeText(container, 'Too slow on my phone', '.voc-other-input')

    expect([hiddenAtFirst, box?.hidden]).toStrictEqual([true, false])
    expect(missing).toBe('✕ Type your answer for Other.')
    expect(await answer(container)).toStrictEqual({ other: 'Too slow on my phone' })
  })

  it("uses the widget's word for Other and its placeholder when the form gives none", async () => {
    const container = await renderWidget(form([single({ other: { enabled: true } })]))

    expect(choiceWords(container).at(-1)).toBe('Other')
    expect(screen(container).querySelector<HTMLInputElement>('.voc-other-input')?.placeholder).toBe('Please specify')
  })
})

describe('the Auto rule: a list for 6 rows or fewer, counting Other and None, a dropdown past that', () => {
  it('shows 5 options and Other (6 rows) as a list', async () => {
    const container = await renderWidget(form([single({ options: options(5), other: OTHER })]))

    expect([screen(container).querySelector('select'), screen(container).querySelectorAll('input[type="radio"]').length])
      .toStrictEqual([null, 6])
  })

  it('shows 6 options and Other (7 rows) as a native select, "Choose…" first and Other last', async () => {
    const container = await renderWidget(form([single({ options: options(6), other: OTHER })]))
    const labels = [...screen(container).querySelectorAll('option')].map((option) => option.textContent)

    expect(labels).toStrictEqual(['Choose…', 'Option A', 'Option B', 'Option C', 'Option D', 'Option E', 'Option F', 'Another reason'])
  })

  it('shows a multiple choice of 5 options, Other and None (7 rows) as a button that opens a checklist', async () => {
    const container = await renderWidget(form([multi({ options: options(5), other: OTHER, none: { enabled: true } })]))
    const toggle = screen(container).querySelector<HTMLButtonElement>('.voc-dropdown')

    expect([toggle?.textContent, toggle?.getAttribute('aria-expanded')]).toStrictEqual(['Choose…', 'false'])
    expect(screen(container).querySelector('select[multiple]')).toBeNull()
  })

  it('respects List, Dropdown and Chips whatever the count', async () => {
    const list = await renderWidget(form([single({ options: options(9), display: 'list' })]))
    const listRadios = screen(list).querySelectorAll('input[type="radio"]').length
    const dropdown = await renderWidget(form([single({ display: 'dropdown' })]))
    const select = screen(dropdown).querySelector('select')
    const chips = await renderWidget(form([single({ display: 'chips' })]))

    expect([listRadios, select === null]).toStrictEqual([9, false])
    expect(screen(chips).querySelector<HTMLElement>('.voc-opt')?.style.borderRadius).toBe('999px')
  })
})

describe('single choice as a dropdown', () => {
  it('sends the picked code, and reveals Other\'s box when Other is picked', async () => {
    const container = await renderWidget(form([single({ display: 'dropdown', other: OTHER })]))
    selectValue(container, '#other')
    const shown = screen(container).querySelector<HTMLElement>('.voc-other')?.hidden
    selectValue(container, 'c')

    expect(shown).toBe(false)
    expect(await answer(container)).toStrictEqual({ code: 'c' })
  })
})

describe('multiple choice', () => {
  it('is checkboxes in full-width rows, and sends the codes in the form\'s order', async () => {
    const container = await renderWidget(form([multi()]))
    pickByKey(container, 'Option D')
    pickByKey(container, 'Option A')

    expect(screen(container).querySelectorAll('input[type="checkbox"]')).toHaveLength(4)
    expect(await answer(container)).toStrictEqual({ codes: ['a', 'd'] })
  })

  it('makes None exclusive: ticking it clears the others, ticking another clears it', async () => {
    const container = await renderWidget(form([multi({ none: { enabled: true } })]))
    pickByKey(container, 'Option A')
    pickByKey(container, 'None of these')
    const afterNone = [choice(container, 'Option A').checked, choice(container, 'None of these').checked]
    pickByKey(container, 'Option B')

    expect(afterNone).toStrictEqual([false, true])
    expect([choice(container, 'None of these').checked, choice(container, 'Option B').checked]).toStrictEqual([false, true])
  })

  it('sends None as codes ["none"]', async () => {
    const container = await renderWidget(form([multi({ none: { enabled: true } })]))
    pickByKey(container, 'None of these')

    expect(await answer(container)).toStrictEqual({ codes: ['none'] })
  })

  it('sends Other\'s text beside the codes', async () => {
    const container = await renderWidget(form([multi({ other: OTHER })]))
    pickByKey(container, 'Option C')
    pickByKey(container, 'Another reason')
    typeText(container, 'Exports', '.voc-other-input')

    expect(await answer(container)).toStrictEqual({ codes: ['c'], other: 'Exports' })
  })

  it.each([
    [{}, 'Choose all that apply'], [{ max: 3 }, 'Choose up to 3'], [{ min: 2 }, 'Choose at least 2'],
    [{ min: 2, max: 3 }, 'Choose 2 to 3'], [{ min: 2, max: 2 }, 'Choose 2'],
  ])('says %j under the headline as "%s", and the group is described by it', async (bounds, hint) => {
    const container = await renderWidget(form([multi(bounds)]))
    const shown = screen(container).querySelector('.voc-hint')
    const describedBy = screen(container).querySelector('[role="group"]')?.getAttribute('aria-describedby') ?? ''

    expect(shown?.textContent).toBe(hint)
    expect(describedBy.split(' ')).toContain(shown?.id)
  })

  it('refuses a tick past the maximum, saying so, and a selection under the minimum', async () => {
    const container = await renderWidget(form([multi({ min: 2, max: 2 })]))
    pickByKey(container, 'Option A')
    clickNext(container)
    const tooFew = errorText(container)
    pickByKey(container, 'Option B')
    pickByKey(container, 'Option C')

    expect(tooFew).toBe('✕ Choose at least 2 to continue.')
    expect([errorText(container), choice(container, 'Option C').checked]).toStrictEqual(['✕ You can choose up to 2.', false])
  })
})

describe('multiple choice as a dropdown (an inline checklist)', () => {
  it('opens below its button, counts what is ticked, and Escape closes it back on the button', async () => {
    const container = await renderWidget(form([multi({ options: options(8) })]))
    const toggle = screen(container).querySelector<HTMLButtonElement>('.voc-dropdown')
    toggle?.click()
    pickByKey(container, 'Option B')
    pickByKey(container, 'Option H')
    const opened = [toggle?.getAttribute('aria-expanded'), toggle?.textContent]
    press(choice(container, 'Option H'), 'Escape')

    expect(opened).toStrictEqual(['true', '2 selected'])
    expect([toggle?.getAttribute('aria-expanded'), focused(container) === toggle]).toStrictEqual(['false', true])
    expect(await answer(container)).toStrictEqual({ codes: ['b', 'h'] })
  })

  it('has a search box past 12 options that filters by label and says when nothing matches', async () => {
    const container = await renderWidget(form([multi({ options: options(13) })]))
    screen(container).querySelector<HTMLButtonElement>('.voc-dropdown')?.click()
    typeText(container, 'option m', '.voc-search')
    const shown = [...screen(container).querySelectorAll<HTMLElement>('.voc-opt')].filter((row) => row.style.display !== 'none')
    typeText(container, 'zzz', '.voc-search')

    expect(shown.map((row) => row.textContent)).toStrictEqual(['Option M'])
    expect(screen(container).querySelector<HTMLElement>('.voc-no-matches')?.hidden).toBe(false)
  })
})

describe('shuffle', () => {
  const MANY = options(6)

  it('keeps Other and None last, and every option once', async () => {
    const container = await renderWidget(form([multi({ options: MANY, shuffle: 'all', other: OTHER, none: { enabled: true }, display: 'list' })]))
    const words = choiceWords(container)

    expect(words.slice(-2)).toStrictEqual(['Another reason', 'None of these'])
    expect(words.slice(0, -2).sort((a, b) => a.localeCompare(b))).toStrictEqual(MANY.map((option) => option.label.en))
  })

  it('keeps the last option in place with except_last', async () => {
    const container = await renderWidget(form([single({ options: MANY, shuffle: 'except_last', display: 'list' })]))

    expect(choiceWords(container).at(-1)).toBe('Option F')
  })

  it('shuffles once per respondent: Back shows the same order', async () => {
    const text: Question = { id: 'q_more', type: 'open_text', headline: en('More?'), required: false }
    const container = await renderWidget(form([multi({ options: options(12), shuffle: 'all', display: 'list' }), text]))
    const first = choiceWords(container)
    pickByKey(container, 'Option A')
    clickNext(container)
    const onText = heading(container)
    backButton(container).click()

    expect(onText).toBe('More?')
    expect(choiceWords(container)).toStrictEqual(first)
  })
})
