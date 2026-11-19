/**
 * The widget keeps the page it lands on out (UX audit §1.2, F1 and F2): it draws in an open shadow root of its
 * container with its own reset, sets every colour and inherited text property inline (so a browser without Shadow
 * DOM, or a page whose CSP blocks the widget's stylesheet, still gets the theme's form), and draws its own checkboxes
 * and radios. A hostile page (a dark site's `h2 { color: #fff }`, a forms reset, uppercase buttons) never restyles
 * it, its ids resolve inside its own root, and the page's keys never drive it.
 *
 * jsdom applies the page's stylesheets to nodes in a shadow root too (a real browser does not), so the computed
 * colours below prove the inline layer, the one that holds even without a shadow root.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  choice, clickNext, en, form, heading, nextButton, pickByKey, press, pressIn, renderWidget, resetWidgetPage, screen,
  submissions, widgetRoot,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

const HOSTILE_CSS = [
  'h1, h2, h3 { color: #ffffff; letter-spacing: 0.02em; hyphens: auto; }',
  'p, span, label, legend { color: #e6e6e6; }',
  'legend { float: left; }',
  'input { appearance: none; background: #000000; }',
  'input[type=checkbox], input[type=radio] { width: 16px; height: 16px; background: #1b1e24; border: 1px solid #3a3f48; }',
  'button { text-transform: uppercase; letter-spacing: 0.08em; background: #222222; color: #ffffff; }',
].join('\n')

/** The dark customer page of the audit's screenshot 23: its rules in the document's <head>. */
function hostilePage(): void {
  const style = document.createElement('style')
  style.id = 'hostile-page'
  style.textContent = HOSTILE_CSS
  document.head.appendChild(style)
}

afterEach(() => {
  document.getElementById('hostile-page')?.remove()
  resetWidgetPage()
})

const KIRO_TEXT = 'rgb(25, 22, 29)'
const KIRO_PRIMARY = 'rgb(142, 72, 255)'

const OPEN: Question = { id: 'q_open', type: 'open_text', headline: en('What happened?'), required: false, long: false }
const MULTI: Question = {
  id: 'q_multi', type: 'multi_select', headline: en('Which ones?'), subheader: en('Pick any.'), required: false,
  display: 'list', options: [{ code: 'a', label: en('Apples') }, { code: 'b', label: en('Pears') }],
}
const SINGLE: Question = {
  id: 'q_single', type: 'single_select', headline: en('Which one?'), required: true, display: 'list',
  options: [{ code: 'a', label: en('Apples') }, { code: 'b', label: en('Pears') }],
}

/** The drawn box beside the choice `words`. */
function boxOf(container: HTMLElement, words: string): HTMLElement {
  const box = choice(container, words).parentElement?.querySelector<HTMLElement>('.voc-box')
  if (box === null || box === undefined) throw new Error(`no drawn box for "${words}"`)
  return box
}

describe('the shadow root', () => {
  it("draws in an open shadow root of the container, and leaves the container's own styles and classes alone", async () => {
    const container = await renderWidget(form([OPEN]))

    expect(container.shadowRoot?.mode).toBe('open')
    expect([container.getAttribute('style'), container.className]).toStrictEqual([null, ''])
    expect(container.shadowRoot?.querySelectorAll('.voc-root')).toHaveLength(1)
    expect(container.children).toHaveLength(0)
  })

  it('ships its reset inside the shadow root, the page untouched', async () => {
    const container = await renderWidget(form([OPEN]))
    const css = container.shadowRoot?.querySelector('style')?.textContent ?? ''

    expect(css).toContain(':host{all:initial;display:block;')
    expect(css).toMatch(/h1,[^{]*h2,[^{]*p,[^{]*legend\{margin:0;color:inherit;font:inherit;letter-spacing:normal;/)
    expect(css).toMatch(/input,[^{]*select,[^{]*textarea,[^{]*button\{font:inherit;color:inherit;/)
    expect(document.head.querySelectorAll('style')).toHaveLength(0)
  })

  it("sets the text properties a page would hand down inline on its inner root (they hold where the page's CSP blocks the stylesheet)", async () => {
    const root = widgetRoot(await renderWidget(form([OPEN])))

    expect({
      color: root.style.color, fontSize: root.style.fontSize, letterSpacing: root.style.letterSpacing,
      wordSpacing: root.style.wordSpacing, textTransform: root.style.textTransform, textIndent: root.style.textIndent,
      fontStyle: root.style.fontStyle, fontWeight: root.style.fontWeight, whiteSpace: root.style.whiteSpace,
      textShadow: root.style.textShadow, cursor: root.style.cursor,
    }).toStrictEqual({
      color: KIRO_TEXT, fontSize: '16px', letterSpacing: 'normal', wordSpacing: 'normal', textTransform: 'none',
      textIndent: '0px', fontStyle: 'normal', fontWeight: '400', whiteSpace: 'normal', textShadow: 'none', cursor: 'auto',
    })
    expect(root.style.getPropertyValue('hyphens')).toBe('manual')
  })

  it("falls back to the container itself where attachShadow is missing, styled inline all the same", async () => {
    const container = await renderWidget(form([OPEN]), {}, {
      beforeInit: "document.getElementById('voc-feedback-form').attachShadow = undefined;",
    })
    const root = container.querySelector<HTMLElement>('.voc-root')

    expect(container.shadowRoot).toBeNull()
    expect([root?.style.color, root?.querySelector<HTMLElement>('h2')?.style.color]).toStrictEqual([KIRO_TEXT, KIRO_TEXT])
  })

  it('says a disabled form is unavailable inside its shadow root, in the form colours', async () => {
    const container = await renderWidget({ ...form([OPEN]), enabled: false, theme: { mode: 'dark' } })
    const status = widgetRoot(container).querySelector<HTMLElement>('[role="status"]')

    expect([status?.textContent, status?.style.color, widgetRoot(container).style.background])
      .toStrictEqual(['Feedback form unavailable.', 'rgb(242, 241, 244)', 'rgb(25, 22, 29)'])
  })
})

describe('a hostile page', () => {
  it("never restyles the heading, the texts, the fields or the buttons", async () => {
    hostilePage()
    const container = await renderWidget(form([MULTI, OPEN]))
    const head = screen(container).querySelector('h2')
    const hint = screen(container).querySelector('p')
    const legend = screen(container).querySelector('legend')
    const next = nextButton(container)
    const computed = (node: Element | null) => (node === null ? null : getComputedStyle(node))

    expect([computed(head)?.color, computed(head)?.letterSpacing, computed(hint)?.color, computed(legend)?.float])
      .toStrictEqual([KIRO_TEXT, 'normal', KIRO_TEXT, 'none'])
    expect([computed(next)?.textTransform, computed(next)?.letterSpacing, computed(next)?.backgroundColor, computed(next)?.color])
      .toStrictEqual(['none', 'normal', KIRO_PRIMARY, 'rgb(255, 255, 255)'])
    expect(computed(screen(container).querySelector('.voc-opt span:last-child'))?.color).toBe(KIRO_TEXT)
    clickNext(container)
    expect(computed(screen(container).querySelector('.voc-input'))?.backgroundColor).toBe('rgb(255, 255, 255)')
  })

  it("draws its own checkbox: a 20 px box with the option edge, then the primary with an on-primary tick", async () => {
    hostilePage()
    const container = await renderWidget(form([MULTI]))
    const style = boxOf(container, 'Apples').style
    const before = [style.width, style.height, style.borderRadius, style.backgroundColor, style.borderColor]
    const input = choice(container, 'Apples')
    pickByKey(container, 'Apples')
    const after = boxOf(container, 'Apples')
    const tick = after.querySelector('path')

    expect(before).toStrictEqual(['20px', '20px', '4px', 'rgb(255, 255, 255)', 'rgba(25, 22, 29, 0.55)'])
    expect([after.style.backgroundColor, after.style.borderColor, tick?.getAttribute('stroke'), tick?.style.display])
      .toStrictEqual([KIRO_PRIMARY, KIRO_PRIMARY, '#ffffff', ''])
    // The real checkbox is still there for the keyboard and screen readers, visually hidden, never the page's box.
    expect([input.type, input.checked, input.style.position, input.style.width, getComputedStyle(input).width])
      .toStrictEqual(['checkbox', true, 'absolute', '1px', '1px'])
    expect(after.getAttribute('aria-hidden')).toBe('true')
  })

  it('draws a radio round, with an on-primary dot when picked', async () => {
    const container = await renderWidget(form([SINGLE, OPEN]))
    pickByKey(container, 'Pears')
    const box = boxOf(container, 'Pears')

    expect([box.style.borderRadius, box.style.backgroundColor, box.querySelector('circle')?.getAttribute('fill')])
      .toStrictEqual(['50%', KIRO_PRIMARY, '#ffffff'])
    expect(boxOf(container, 'Apples').querySelector<SVGElement>('circle')?.style.display).toBe('none')
  })

  it('keeps the real input focusable, with the focus ring on the box for the keyboard only', async () => {
    const container = await renderWidget(form([MULTI]))
    const input = choice(container, 'Apples')
    press(input, 'Tab')
    input.focus()
    const byKey = boxOf(container, 'Apples').style.boxShadow
    const focusedInside = container.shadowRoot?.activeElement === input
    input.blur()
    const blurred = boxOf(container, 'Apples').style.boxShadow
    input.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    input.focus()

    expect([focusedInside, blurred, boxOf(container, 'Apples').style.boxShadow]).toStrictEqual([true, '', ''])
    expect(byKey).toBe('0 0 0 2px #ffffff,0 0 0 4px #8e48ff')
  })
})

describe('ids and keys stay in the form', () => {
  it('resolves every id it names (labels, descriptions, controls) inside its own shadow root, none in the page', async () => {
    const container = await renderWidget(form([MULTI, OPEN]))
    const shadow = container.shadowRoot
    const named = [...(shadow?.querySelectorAll('[aria-describedby], [aria-labelledby], [aria-controls], label[for]') ?? [])]
      .flatMap((node) => ['aria-describedby', 'aria-labelledby', 'aria-controls', 'for']
        .flatMap((name) => (node.getAttribute(name) ?? '').split(' ').filter((id) => id !== '')))

    expect(named.length).toBeGreaterThan(3)
    expect(named.filter((id) => shadow?.getElementById(id) === null)).toStrictEqual([])
    expect(named.filter((id) => document.getElementById(id) !== null)).toStrictEqual([])
  })

  it("does nothing on the page's own Enter and arrow keys, and still answers its own", async () => {
    const container = await renderWidget(form([OPEN, { ...OPEN, id: 'q_two', headline: en('Anything else?') }]))
    const field = document.createElement('input')
    document.body.appendChild(field)
    const handled = ['Enter', 'ArrowDown', 'ArrowUp'].map((key) => press(field, key))

    expect([handled, heading(container), submissions()]).toStrictEqual([[false, false, false], 'What happened?', []])
    expect(pressIn(container, '.voc-input', 'Enter')).toBe(true)
    expect(heading(container)).toBe('Anything else?')
  })
})
