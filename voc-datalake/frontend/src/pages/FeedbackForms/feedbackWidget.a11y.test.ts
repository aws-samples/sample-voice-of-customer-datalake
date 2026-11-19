/**
 * The widget's keyboard, focus and screen-reader basics (UX spec §11.2, §13.3; audit W3–W9): keys handled on the
 * form's own container only (a host page's Enter and arrows do nothing), Enter once, Ctrl/⌘+Enter in long text,
 * auto-advance on a pointer only, one screen in the page at a time, a named group per question, focus on each
 * step, live progress, alert errors, 44–48 px targets and reduced motion.
 */
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  backButton, choice, clickNext, en, errorText, focused, form, heading, nextButton, openText, pickByKey, pickByPointer,
  press, pressIn, renderWidget, resetWidgetPage, screen, submissions, typeText, widgetRoot,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

afterEach(resetWidgetPage)

const PICK: Question = {
  id: 'q_pick', type: 'single_select', headline: en('Why?'), required: true,
  options: [{ code: 'price', label: en('Price') }, { code: 'bugs', label: en('Bugs') }],
}
const THREE = form([openText('q_a', 'First'), openText('q_b', 'Second'), openText('q_c', 'Third')])

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
    const container = await renderWidget(form([openText('q_a', 'First', { long: true }), openText('q_b', 'Second', { long: true }), openText('q_c', 'Third')]))
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
    const container = await renderWidget(form([PICK, openText('q_b', 'Second')]))
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
    const container = await renderWidget(form([PICK, openText('q_b', 'Second')]))
    pickByPointer(container, 'Price')

    await waitFor(() => expect(heading(container)).toBe('Second'))
  })

  it('never moves on after a pick from the keyboard (arrow keys walk the radios)', async () => {
    const container = await renderWidget(form([PICK, openText('q_b', 'Second')]))
    pickByKey(container, 'Price')
    await new Promise((done) => { setTimeout(done, 400) })

    expect(heading(container)).toBe('Why?')
  })

  it('never moves on when Other is picked', async () => {
    const container = await renderWidget(form([{ ...PICK, other: { enabled: true } }, openText('q_b', 'Second')]))
    pickByPointer(container, 'Other')
    await new Promise((done) => { setTimeout(done, 400) })

    expect(heading(container)).toBe('Why?')
  })
})

describe('one screen at a time', () => {
  it('keeps only the screen on show in the page, so nothing hidden can be tabbed to', async () => {
    const container = await renderWidget(form([PICK, openText('q_b', 'Second')]))
    pickByKey(container, 'Price')
    clickNext(container)
    const inputs = [...widgetRoot(container).querySelectorAll('input, textarea, select')]

    expect(widgetRoot(container).querySelectorAll('.voc-screen')).toHaveLength(1)
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
    expect(focused(container)).toBe(choice(container, 'Price'))
  })

  it('announces the progress politely and on the progress bar', async () => {
    const container = await renderWidget(THREE)
    const bar = widgetRoot(container).querySelector('[role="progressbar"]')

    expect(widgetRoot(container).querySelector('.voc-live')?.getAttribute('aria-live')).toBe('polite')
    expect([bar?.getAttribute('aria-valuenow'), bar?.getAttribute('aria-valuemax'), bar?.getAttribute('aria-valuetext')])
      .toStrictEqual(['1', '3', 'Question 1 of 3'])
  })

  it('shows the rarer of "Required" and "Optional" under the headline', async () => {
    const container = await renderWidget(form([PICK, openText('q_b', 'Second'), { ...PICK, id: 'q_again' }]))
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
    const container = await renderWidget(form([openText('q_a', 'First'), PICK]))
    clickNext(container)
    const onChoice = focused(container) === screen(container).querySelector('h2')
    backButton(container).click()

    expect(onChoice).toBe(true)
    expect(focused(container)).toBe(screen(container).querySelector('.voc-input'))
  })

  it("moves focus to the ending's title", async () => {
    const container = await renderWidget(form([openText('q_a', 'First')]))
    clickNext(container)

    await waitFor(() => expect(focused(container)?.textContent).toBe('Thanks!'))
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

  it("pins a phone's Back and Next to the bottom: the sticky bar is the screen's own child, the notice above the buttons", async () => {
    // A 375 px wide container (jsdom has no layout), set in the widget's realm and undone after.
    const narrow = "var widthWas = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'); " +
      "Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: function () { return 375; } }); " +
      "document.body.__vocWide = function () { if (widthWas) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthWas); else delete HTMLElement.prototype.clientWidth; };"
    const eight = Array.from({ length: 8 }, (_, i) => ({ code: `o${i}`, label: en(`Option ${i}`) }))
    try {
      const container = await renderWidget(form([{ ...PICK, display: 'list', options: eight }, openText('q_b', 'Second')]), {}, { beforeInit: narrow })
      const bar = nextButton(container).closest<HTMLElement>('.voc-nav-bar')

      expect([bar?.style.position, bar?.style.bottom, bar?.parentElement === screen(container)]).toStrictEqual(['sticky', '0px', true])
      expect([...(bar?.children ?? [])].map((child) => child.className)).toStrictEqual(['voc-submit-error', 'voc-nav'])
      expect(bar?.style.background).toBe('rgb(255, 255, 255)')
    } finally {
      const wide: unknown = Reflect.get(document.body, '__vocWide')
      if (typeof wide === 'function') Reflect.apply(wide, undefined, [])
      Reflect.deleteProperty(document.body, '__vocWide')
    }
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
    const onTouch = widgetRoot(touch).querySelector('.voc-enter-hint')
    document.body.dataset.media = 'fine'
    const mouse = await renderWidget(THREE)

    expect(onTouch).toBeNull()
    expect(widgetRoot(mouse).querySelector('.voc-enter-hint')?.textContent).toBe('Press Enter ↵')
  })

  it('reads "Ctrl+Enter" under a long text', async () => {
    document.body.dataset.media = 'fine'
    const container = await renderWidget(form([openText('q_a', 'First', { long: true })]))
    typeText(container, 'x', 'textarea')

    expect(widgetRoot(container).querySelector('.voc-enter-hint')?.textContent).toBe('Ctrl+Enter to continue (⌘+Enter on a Mac)')
  })
})
