/**
 * The widget's keyboard, focus and screen-reader basics (UX spec §11.2, §13.3; audit W3–W9): keys handled on the
 * form's own container only (a host page's Enter and arrows do nothing), Enter once, Ctrl/⌘+Enter in long text,
 * auto-advance on a pointer only, one screen in the page at a time, a named group per question, focus on each
 * step, live progress, alert errors, 44–48 px targets and reduced motion.
 */
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backButton, choice, clickNext, en, errorText, form, heading, nextButton, pickByKey, pickByPointer, press, pressIn,
  renderWidget, resetWidgetPage, screen, submissions, typeText,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

afterEach(resetWidgetPage)

function open(id: string, title: string, extra: Record<string, unknown> = {}): Question {
  return { id, type: 'open_text', headline: en(title), required: false, long: false, input_type: 'text', ...extra }
}

const PICK: Question = {
  id: 'q_pick', type: 'single_select', headline: en('Why?'), required: true,
  options: [{ code: 'price', label: en('Price') }, { code: 'bugs', label: en('Bugs') }],
}
const THREE = form([open('q_a', 'First'), open('q_b', 'Second'), open('q_c', 'Third')])

describe('keys belong to the form, never to the page around it', () => {
  it("does nothing on a host page's Enter and arrow keys", async () => {
    const container = await renderWidget(THREE)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    const handled = ['Enter', 'ArrowDown', 'ArrowUp'].flatMap((key) => [press(outside, key), press(document.body, key)])

    expect(handled).toStrictEqual([false, false, false, false, false, false])
    expect(heading(container)).toBe('First')
  })

  it('goes Next once on Enter in a short field', async () => {
    const container = await renderWidget(THREE)

    expect(pressIn(container, '.voc-input', 'Enter')).toBe(true)
    expect(heading(container)).toBe('Second')
  })

  it('keeps Enter as a new line in long text, and goes Next on Ctrl+Enter or ⌘+Enter', async () => {
    const container = await renderWidget(form([open('q_a', 'First', { long: true }), open('q_b', 'Second', { long: true }), open('q_c', 'Third')]))
    const plain = pressIn(container, 'textarea', 'Enter')
    pressIn(container, 'textarea', 'Enter', { ctrlKey: true })
    const second = heading(container)
    pressIn(container, 'textarea', 'Enter', { metaKey: true })

    expect([plain, second, heading(container)]).toStrictEqual([false, 'Second', 'Third'])
  })

  it("leaves a button's Enter to the button (its own click), so it is never handled twice", async () => {
    const container = await renderWidget(THREE)

    expect(press(nextButton(container), 'Enter')).toBe(false)
    expect(heading(container)).toBe('First')
  })

  it('ignores Enter while an input method is composing (Japanese, Chinese, Korean)', async () => {
    const container = await renderWidget(THREE)
    pressIn(container, '.voc-input', 'Enter', { isComposing: true })

    expect(heading(container)).toBe('First')
  })

  it('goes Next on Enter on a choice screen (and asks for an answer first)', async () => {
    const container = await renderWidget(form([PICK, open('q_b', 'Second')]))
    press(choice(container, 'Price'), 'Enter')
    const asked = errorText(container)
    pickByKey(container, 'Bugs')
    press(choice(container, 'Bugs'), 'Enter')

    expect([asked, heading(container)]).toStrictEqual(['✕ Choose an answer to continue.', 'Second'])
  })

  it('uses Escape for nothing but an open dropdown', async () => {
    const container = await renderWidget(THREE)

    expect(pressIn(container, '.voc-input', 'Escape')).toBe(false)
  })
})

describe('auto-advance (WCAG 3.2.2)', () => {
  it('moves on after a single choice picked with a pointer', async () => {
    const container = await renderWidget(form([PICK, open('q_b', 'Second')]))
    pickByPointer(container, 'Price')

    await waitFor(() => expect(heading(container)).toBe('Second'))
  })

  it('never moves on after a pick from the keyboard (arrow keys walk the radios)', async () => {
    const container = await renderWidget(form([PICK, open('q_b', 'Second')]))
    pickByKey(container, 'Price')
    await new Promise((done) => { setTimeout(done, 400) })

    expect(heading(container)).toBe('Why?')
  })

  it('never moves on when Other is picked', async () => {
    const container = await renderWidget(form([{ ...PICK, other: { enabled: true } }, open('q_b', 'Second')]))
    pickByPointer(container, 'Other')
    await new Promise((done) => { setTimeout(done, 400) })

    expect(heading(container)).toBe('Why?')
  })
})

describe('one screen at a time', () => {
  it('keeps only the screen on show in the page, so nothing hidden can be tabbed to', async () => {
    const container = await renderWidget(form([PICK, open('q_b', 'Second')]))
    pickByKey(container, 'Price')
    clickNext(container)
    const inputs = [...container.querySelectorAll('input, textarea, select')]

    expect(container.querySelectorAll('.voc-screen')).toHaveLength(1)
    expect(inputs.map((input) => input.className)).toStrictEqual(['voc-input'])
  })
})

describe('structure for screen readers', () => {
  it('makes each question a fieldset whose legend is the headline (a heading)', async () => {
    const container = await renderWidget(form([PICK]))
    const legend = screen(container).querySelector('fieldset > legend')

    expect(legend?.querySelector('h2')?.textContent).toBe('Why?')
    expect(screen(container).querySelector('[role="radiogroup"]')?.getAttribute('aria-required')).toBe('true')
  })

  it('says an error in an alert linked to the control, and keeps focus on the control', async () => {
    const container = await renderWidget(form([PICK]))
    clickNext(container)
    const error = screen(container).querySelector('.voc-error')
    const group = screen(container).querySelector('[role="radiogroup"]')

    expect([error?.getAttribute('role'), errorText(container)]).toStrictEqual(['alert', '✕ Choose an answer to continue.'])
    expect(group?.getAttribute('aria-describedby')?.split(' ')).toContain(error?.id)
    expect(document.activeElement).toBe(choice(container, 'Price'))
  })

  it('announces the progress politely and on the progress bar', async () => {
    const container = await renderWidget(THREE)
    const bar = container.querySelector('[role="progressbar"]')

    expect(container.querySelector('.voc-live')?.getAttribute('aria-live')).toBe('polite')
    expect([bar?.getAttribute('aria-valuenow'), bar?.getAttribute('aria-valuemax'), bar?.getAttribute('aria-valuetext')])
      .toStrictEqual(['1', '3', 'Question 1 of 3'])
  })

  it('shows the rarer of "Required" and "Optional" under the headline', async () => {
    const container = await renderWidget(form([PICK, open('q_b', 'Second'), { ...PICK, id: 'q_again' }]))
    const onRequired = screen(container).querySelector('fieldset')?.textContent
    pickByKey(container, 'Price')
    clickNext(container)

    expect(onRequired).not.toContain('Optional')
    expect(screen(container).querySelector('fieldset')?.textContent).toContain('Optional')
  })
})

describe('focus', () => {
  it('leaves focus alone on the first screen (it must not pull focus away from a host page)', async () => {
    await renderWidget(THREE)

    expect(document.activeElement).toBe(document.body)
  })

  it('moves focus to the field on a text screen and to the heading on any other', async () => {
    const container = await renderWidget(form([open('q_a', 'First'), PICK]))
    clickNext(container)
    const onChoice = document.activeElement === screen(container).querySelector('h2')
    backButton(container).click()

    expect(onChoice).toBe(true)
    expect(document.activeElement).toBe(screen(container).querySelector('.voc-input'))
  })

  it("moves focus to the ending's title", async () => {
    const container = await renderWidget(form([open('q_a', 'First')]))
    clickNext(container)

    await waitFor(() => expect(document.activeElement?.textContent).toBe('Thanks!'))
    expect(submissions()).toHaveLength(1)
  })
})

describe('targets and motion', () => {
  it('gives choice rows 48 px, scale cells 44 px and NPS cells 40 px from 480 px', async () => {
    const choices = await renderWidget(form([PICK]))
    const row = screen(choices).querySelector<HTMLElement>('.voc-opt')?.style.minHeight
    const stars = await renderWidget(form([{ id: 'q_s', type: 'rating', headline: en('Stars?'), required: true, scale: 'star', range: 5 }]))
    const star = screen(stars).querySelector<HTMLElement>('.voc-scale-cell')?.style
    const nps = await renderWidget(form([{ id: 'q_n', type: 'nps', headline: en('NPS?'), required: true }]))

    expect([row, star?.minWidth, star?.minHeight]).toStrictEqual(['48px', '44px', '44px'])
    expect(screen(nps).querySelector<HTMLElement>('.voc-scale-cell')?.style.minWidth).toBe('40px')
  })

  it('fades a new screen in, and not under prefers-reduced-motion', async () => {
    const moving = await renderWidget(THREE)
    const fade = screen(moving).style.transition
    document.body.dataset.media = 'reduce'
    const still = await renderWidget(THREE)

    expect([fade, screen(still).style.transition]).toStrictEqual(['opacity 200ms ease', ''])
  })

  it('shows the Enter hint only with a fine pointer', async () => {
    const touch = await renderWidget(THREE)
    const onTouch = touch.querySelector('.voc-enter-hint')
    document.body.dataset.media = 'fine'
    const mouse = await renderWidget(THREE)

    expect(onTouch).toBeNull()
    expect(mouse.querySelector('.voc-enter-hint')?.textContent).toBe('Press Enter ↵')
  })

  it('reads "Ctrl+Enter" under a long text', async () => {
    document.body.dataset.media = 'fine'
    const container = await renderWidget(form([open('q_a', 'First', { long: true })]))
    typeText(container, 'x', 'textarea')

    expect(container.querySelector('.voc-enter-hint')?.textContent).toBe('Ctrl+Enter to continue (⌘+Enter on a Mac)')
  })
})
