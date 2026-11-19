/**
 * The widget's theme engine (schema version 2's theme; the contract's contrast rules) and the editor's preview API
 * (UX audit §1.4, §2.2–2.3, F11, F16, F21): light, dark and auto modes (auto follows prefers-color-scheme and its
 * changes), the dark palette's defaults, the safeguards (text under 3:1 replaced, the option edge raised to 3:1, the
 * ring and selected edges in the text colour under a pale primary), fonts, large text, old themes, a seeded
 * shuffle, goTo the welcome screen and an ending, setScheme, and the iframe page's height message.
 */
import { waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  choice, choiceWords, clickNext, en, expectHeading, focused, form, handle, heading, nextButton, pickByKey, renderPreview,
  renderWidget, resetWidgetPage, schemeListenerCount, screen, setDeviceDark, submitted, typeText, widgetRoot,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

const restores: Array<() => void> = []

afterEach(() => {
  restores.splice(0).reverse().forEach((restore) => { restore() })
  resetWidgetPage()
})

const OPEN: Question = { id: 'q_open', type: 'open_text', headline: en('What happened?'), required: false, long: false }
const MORE: Question = { ...OPEN, id: 'q_more', headline: en('Anything else?') }
const MULTI: Question = {
  id: 'q_multi', type: 'multi_select', headline: en('Which ones?'), required: false, display: 'list',
  options: [{ code: 'a', label: en('Apples') }, { code: 'b', label: en('Pears') }],
}

/** A form of `questions` with `theme`. */
function themed(theme: Record<string, unknown>, questions: Question[] = [MULTI, OPEN]): Record<string, unknown> {
  return form(questions, { theme })
}

function rootColours(container: HTMLElement): string[] {
  const root = widgetRoot(container)
  return [root.style.background, root.style.color, root.style.getPropertyValue('color-scheme')]
}

/** The widget's stylesheet in its shadow root. */
function css(container: HTMLElement): string {
  return container.shadowRoot?.querySelector('style')?.textContent ?? ''
}

const VOC_DARK = ['rgb(25, 22, 29)', 'rgb(242, 241, 244)', 'dark']
const VOC_LIGHT = ['rgb(255, 255, 255)', 'rgb(25, 22, 29)', 'light']

describe('mode', () => {
  it('draws a theme without a mode, and mode light, in its light palette', async () => {
    const plain = rootColours(await renderWidget(themed({})))
    const light = rootColours(await renderWidget(themed({ mode: 'light' })))

    expect([plain, light]).toStrictEqual([VOC_LIGHT, VOC_LIGHT])
  })

  it('draws mode dark in the VoC dark palette when the theme has no dark one, with the dark label on its primary', async () => {
    const container = await renderWidget(themed({ mode: 'dark' }))

    expect(rootColours(container)).toStrictEqual(VOC_DARK)
    expect([nextButton(container).style.background, nextButton(container).style.color])
      .toStrictEqual(['rgb(189, 143, 255)', 'rgb(25, 22, 29)'])
    expect(css(container)).toContain('color-scheme:dark')
  })

  it("draws mode dark in the theme's own dark palette", async () => {
    const container = await renderWidget(themed({
      mode: 'dark', primary_color: '#8e48ff', dark: { primary_color: '#00d4ff', background_color: '#000000', text_color: '#ffffff' },
    }))

    expect(rootColours(container)).toStrictEqual(['rgb(0, 0, 0)', 'rgb(255, 255, 255)', 'dark'])
    expect(nextButton(container).style.background).toBe('rgb(0, 212, 255)')
  })

  it("follows the device in mode auto, and its change, keeping the answers and the focus", async () => {
    document.body.dataset.media = 'dark'
    const container = await renderWidget(themed({ mode: 'auto' }, [OPEN, MORE]))
    const atStart = rootColours(container)
    typeText(container, 'kept')
    screen(container).querySelector<HTMLInputElement>('.voc-input')?.focus()
    setDeviceDark(false)

    expect([atStart, rootColours(container)]).toStrictEqual([VOC_DARK, VOC_LIGHT])
    expect(screen(container).querySelector<HTMLInputElement>('.voc-input')?.value).toBe('kept')
    expect(focused(container)).toBe(screen(container).querySelector('.voc-input'))
  })

  it('ignores the device in mode light', async () => {
    const light = await renderWidget(themed({ mode: 'light' }))
    setDeviceDark(true)

    expect(rootColours(light)).toStrictEqual(VOC_LIGHT)
  })

  it('stops listening to the device once destroyed', async () => {
    const auto = await renderWidget(themed({ mode: 'auto' }))
    const listening = schemeListenerCount()
    handle().destroy()
    setDeviceDark(true)

    expect([listening, schemeListenerCount(), rootColours(auto)]).toStrictEqual([1, 0, VOC_LIGHT])
  })
})

describe('the contrast safeguards', () => {
  it('replaces text under 3:1 on its background with one that reads, and keeps 3–4.5:1 (a warning, not an error)', async () => {
    const grey = widgetRoot(await renderWidget(themed({ text_color: '#9ca3af' }))).style.color
    const darkOnBlack = widgetRoot(await renderWidget(themed({ background_color: '#000000', text_color: '#333333' }))).style.color
    const warned = widgetRoot(await renderWidget(themed({ text_color: '#8a8a8a' }))).style.color

    // #9ca3af on white is 2.54:1, #333333 on black 1.66:1; #8a8a8a on white is 3.45:1.
    expect([grey, darkOnBlack, warned]).toStrictEqual(['rgb(25, 22, 29)', 'rgb(255, 255, 255)', 'rgb(138, 138, 138)'])
  })

  it('raises the option edge from 55 % until it holds 3:1', async () => {
    const kiro = await renderWidget(themed({}))
    const kiroEdge = screen(kiro).querySelector<HTMLElement>('.voc-opt')?.style.borderColor
    const grey = await renderWidget(themed({ text_color: '#767676' }))

    // Kiro text at 55 % over white is 3.9:1; #767676 needs 80 % (3.15:1; 75 % is 2.89:1).
    expect(kiroEdge).toBe('rgba(25, 22, 29, 0.55)')
    expect(screen(grey).querySelector<HTMLElement>('.voc-opt')?.style.borderColor).toBe('rgba(118, 118, 118, 0.8)')
    expect(nextButton(grey).previousElementSibling).not.toBeNull()
  })

  it('draws the focus ring and the selected edges in the text colour when the primary is under 3:1', async () => {
    const container = await renderWidget(themed({ primary_color: '#f5c518' }))
    pickByKey(container, 'Apples')
    const row = choice(container, 'Apples').closest('label')
    const box = row?.querySelector<HTMLElement>('.voc-box')

    // #f5c518 on white is 1.63:1: it still fills, with the dark label and an edge that shows.
    expect([row?.style.borderColor, box?.style.backgroundColor, box?.style.borderColor])
      .toStrictEqual(['rgb(25, 22, 29)', 'rgb(245, 197, 24)', 'rgb(25, 22, 29)'])
    expect(nextButton(container).style.color).toBe('rgb(25, 22, 29)')
    expect(css(container)).toContain(':focus-visible{outline:3px solid #19161d;')
  })

  it('keeps the primary for the ring and the selected edges when it holds 3:1', async () => {
    const container = await renderWidget(themed({}))
    pickByKey(container, 'Apples')

    expect(choice(container, 'Apples').closest('label')?.style.borderColor).toBe('rgb(142, 72, 255)')
    expect(css(container)).toContain(':focus-visible{outline:3px solid #8e48ff;')
  })

  it('reads an old theme: #rgb expanded, a #rrggbbaa drawn as its 6-digit colour, anything else the default', async () => {
    const short = await renderWidget(themed({ primary_color: '#abc' }))
    const alpha = await renderWidget(themed({ primary_color: '#3b82f680', border_radius: '12px' }))

    expect([nextButton(short).style.background, nextButton(alpha).style.background, nextButton(alpha).style.borderRadius])
      .toStrictEqual(['rgb(170, 187, 204)', 'rgb(59, 130, 246)', '12px'])
  })

  it('draws the shared vector as the editor and the server judge it: #19161d80 on #ffffff00 as #19161d on #ffffff, kept', async () => {
    // (the same vector in theme/contrast.test.ts and lambda/shared/test/test_form_theme.py: 17.89:1, its alpha dropped)
    const container = await renderWidget(themed({ text_color: '#19161d80', background_color: '#ffffff00' }))

    expect(rootColours(container).slice(0, 2)).toStrictEqual(['rgb(255, 255, 255)', 'rgb(25, 22, 29)'])
  })

  it.each([['0px', '0px'], ['39px', '39px'], ['40px', '40px'], ['99px', '99px'], ['100px', '8px'], ['1.5px', '8px']])(
    'draws a %s corner as %s, the 0 to 99 px the API and the editor take', async (radius, drawn) => {
      expect(nextButton(await renderWidget(themed({ border_radius: radius }))).style.borderRadius).toBe(drawn)
    })
})

describe('font and size', () => {
  it.each([
    ['system', 'system-ui'], ['serif', 'ui-serif'], ['rounded', 'ui-rounded'], ['mono', 'ui-monospace'],
    ['papyrus', 'system-ui'],
  ])('draws font %s in its system stack (never a web font)', async (font, first) => {
    const root = widgetRoot(await renderWidget(themed({ font })))

    expect(root.style.fontFamily.split(',')[0]).toBe(first)
  })

  it("takes the page's own font for 'inherit' on a script embed, and the system stack on the API's page and in the preview", async () => {
    const embed = await renderWidget(themed({ font: 'inherit' }))
    const embedFont = widgetRoot(embed).style.fontFamily
    const embedCss = css(embed)
    const ownPage = await renderWidget(themed({ font: 'inherit' }), {}, { path: '/feedback-forms/f1/iframe' })
    const ownFont = widgetRoot(ownPage).style.fontFamily
    const preview = renderPreview(themed({ font: 'inherit' }))

    expect([embedFont, ownFont.split(',')[0], widgetRoot(preview).style.fontFamily.split(',')[0]])
      .toStrictEqual(['inherit', 'system-ui', 'system-ui'])
    expect(embedCss).toMatch(/:host\{all:initial;[^}]*;font-family:inherit\}/)
  })

  it('scales every text by 18/16 for large text', async () => {
    const container = await renderWidget(themed({ text_size: 'large' }))
    const head = screen(container).querySelector<HTMLElement>('h2')
    const box = screen(container).querySelector<HTMLElement>('.voc-box')

    expect([widgetRoot(container).style.fontSize, head?.style.fontSize, head?.style.lineHeight, box?.style.width])
      .toStrictEqual(['18px', '27px', '36px', '23px'])
  })
})

describe("the editor's preview", () => {
  const FRUIT = ['apple', 'pear', 'plum', 'fig', 'kiwi', 'lime', 'date', 'peach']
  const SHUFFLED: Question = {
    id: 'q_fruit', type: 'single_select', headline: en('Pick a fruit'), required: false, display: 'list', shuffle: 'all',
    options: FRUIT.map((code) => ({ code, label: en(code) })),
  }
  const byWord = (a: string, b: string) => a.localeCompare(b)
  const WITH_ENDS = form([SHUFFLED, OPEN], {
    enabled: false, welcome: { enabled: true, title: en('Welcome!') },
    endings: [{ id: 'end_thanks', title: en('Thanks!') }, { id: 'end_call', title: en('We will call you') }],
  })

  function orderWithSeed(seed: number): string[] {
    const container = renderPreview(WITH_ENDS, { preview: { config: WITH_ENDS, seed } })
    handle().goTo('q_fruit')
    return choiceWords(container)
  }

  it('shuffles by its seed: the same order for the same seed, Restart included', () => {
    const first = orderWithSeed(42)
    handle().restart()
    handle().goTo('q_fruit')
    const restarted = choiceWords(document.querySelector<HTMLElement>('#voc-feedback-form') ?? document.body)
    const again = orderWithSeed(42)
    const other = orderWithSeed(7)

    expect([restarted, again]).toStrictEqual([first, first])
    expect(first).not.toStrictEqual(FRUIT)
    expect(other).not.toStrictEqual(first)
    expect([...first].sort(byWord)).toStrictEqual([...FRUIT].sort(byWord))
  })

  it('shows an option added to a draft at once (a kept order only while the options are the same)', () => {
    const container = renderPreview(form([{ ...SHUFFLED, shuffle: 'none' }], { enabled: false }))
    handle().update(form([{ ...SHUFFLED, shuffle: 'none', options: [...FRUIT, 'yuzu'].map((code) => ({ code, label: en(code) })) }], { enabled: false }))

    expect(choiceWords(container)).toStrictEqual([...FRUIT, 'yuzu'])
  })

  it("goes to the welcome screen and to an ending, and stays where it is for one the form doesn't have", () => {
    const container = renderPreview(WITH_ENDS)
    handle().goTo('end:end_call')
    const ending = heading(container)
    handle().goTo('end:end_gone')
    const stayed = heading(container)
    handle().goTo('welcome')

    expect([ending, stayed, heading(container)]).toStrictEqual(['We will call you', 'We will call you', 'Welcome!'])
    const noWelcome = renderPreview(form([OPEN], { enabled: false }))
    handle().goTo('welcome')
    expect(heading(noWelcome)).toBe('What happened?')
  })

  it('keeps showing the ending (or the welcome screen) an author is editing as the draft changes', () => {
    const container = renderPreview(WITH_ENDS)
    handle().goTo('end:end_call')
    handle().update({ ...WITH_ENDS, endings: [{ id: 'end_thanks', title: en('Thanks!') }, { id: 'end_call', title: en('We call back') }] })
    const ending = heading(container)
    handle().goTo('welcome')
    handle().update({ ...WITH_ENDS, welcome: { enabled: true, title: en('Hello!') } })

    expect([ending, heading(container)]).toStrictEqual(['We call back', 'Hello!'])
  })

  it('shows the palette it is told (preview.scheme, setScheme), and the theme’s own again for null', () => {
    const config = form([OPEN], { enabled: false, theme: { mode: 'light' } })
    const container = renderPreview(config, { preview: { config, scheme: 'dark' } })
    const forced = rootColours(container)
    handle().setScheme('light')
    const light = rootColours(container)
    handle().setScheme('dark')
    handle().setScheme(null)

    expect([forced, light, rootColours(container)]).toStrictEqual([VOC_DARK, VOC_LIGHT, VOC_LIGHT])
  })
})

describe("the API's own iframe page", () => {
  /**
   * Run in the widget's realm before `init` (its `window` is not the test's): the page is framed, its parent's
   * postMessage calls land on `<body data-posted>`, and the widget's inner root measures `<body data-root-height>`
   * px tall (jsdom has no layout). `__vocUnframe` on <body> undoes both.
   */
  const FRAMED = [
    "var parentWas = Object.getOwnPropertyDescriptor(window, 'parent');",
    "Object.defineProperty(window, 'parent', { configurable: true, value: { postMessage: function (data, origin) { var d = document.body.dataset; var sent = JSON.parse(d.posted || '[]'); sent.push({ data: data, origin: origin }); d.posted = JSON.stringify(sent); } } });",
    'var measure = Element.prototype.getBoundingClientRect;',
    "Element.prototype.getBoundingClientRect = function () { if (!this.classList.contains('voc-root')) return measure.call(this); var h = Number(document.body.dataset.rootHeight || 0); return { x: 0, y: 0, top: 0, left: 0, width: 375, right: 375, height: h, bottom: h }; };",
    "document.body.__vocUnframe = function () { Element.prototype.getBoundingClientRect = measure; if (parentWas) Object.defineProperty(window, 'parent', parentWas); else delete window.parent; };",
  ].join('\n')

  /** Undo FRAMED after the test. */
  function unframeAfter(): void {
    restores.push(() => {
      const unframe: unknown = Reflect.get(document.body, '__vocUnframe')
      if (typeof unframe === 'function') Reflect.apply(unframe, undefined, [])
      Reflect.deleteProperty(document.body, '__vocUnframe')
    })
  }

  /** Render on the API's own iframe page, framed unless `framedPage` is false. */
  async function ownPage(config: Record<string, unknown>, framedPage = true): Promise<HTMLElement> {
    unframeAfter()
    return renderWidget(config, {}, { path: '/feedback-forms/f1/iframe', beforeInit: framedPage ? FRAMED : '' })
  }

  function posted(): unknown[] {
    const parsed: unknown = JSON.parse(document.body.dataset.posted ?? '[]')
    return Array.isArray(parsed) ? parsed : []
  }

  it('posts its height to the parent page when framed, again only when it changes', async () => {
    document.body.dataset.rootHeight = '512.4'
    const container = await ownPage(form([OPEN, MORE]))
    await waitFor(() => expect(posted()).toHaveLength(1))
    typeText(container, 'same height')
    clickNext(container)
    await expectHeading(container, 'Anything else?')
    document.body.dataset.rootHeight = '640'
    typeText(container, 'taller')
    handle().setLanguage('en')
    await waitFor(() => expect(posted()).toHaveLength(2))

    expect(posted()).toStrictEqual([
      { data: { type: 'voc-form-height', height: 513 }, origin: '*' },
      { data: { type: 'voc-form-height', height: 640 }, origin: '*' },
    ])
  })

  it('posts nothing unframed, from a script embed or in the preview', async () => {
    await ownPage(form([OPEN]), false)
    unframeAfter()
    await renderWidget(form([OPEN]), {}, { path: '/pricing', beforeInit: FRAMED })
    renderPreview(form([OPEN], { enabled: false }))
    await new Promise((resolve) => { setTimeout(resolve, 50) })

    expect(posted()).toStrictEqual([])
  })

  it.each([
    ['iframe', true], ['link', false],
  ])('says its response was answered as %s on its own page', async (channel, framedPage) => {
    const container = await ownPage(form([OPEN]), framedPage)
    clickNext(container)

    expect((await submitted()).channel).toBe(channel)
  })

  it('says a script embed on another page was answered as script', async () => {
    const container = await renderWidget(form([OPEN]), {}, { path: '/pricing' })
    clickNext(container)

    expect((await submitted()).channel).toBe('script')
  })

  it('gives the page around the form its palette', async () => {
    await renderWidget(themed({ mode: 'dark' }), {}, { path: '/feedback-forms/f1/iframe' })

    expect([document.documentElement.style.background, document.documentElement.style.colorScheme])
      .toStrictEqual(['rgb(25, 22, 29)', 'dark'])
  })
})
