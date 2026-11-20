/**
 * The widget's matrix (7.61.00, docs/feedback-forms.md "Matrix"): several rows rated on one scale, one choice per row.
 * A grid where the form is wide enough and stacked rows on a phone, one radio group per row whose radios name the row
 * and the column, every row (required) or `min_rows` (optional), rows shuffled once per respondent (the preview's by
 * its seed), and the answer `{rows: {<row>: <column>}}`.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  answersOf, choice, clickNext, en, errorText, focused, form, handle, heading, openText, pickByKey, pickByPointer,
  pressIn, renderPreview, renderWidget, resetWidgetPage, screen, submitted,
} from '../../test/feedbackWidgetHarness'
import type { Question } from '../../test/feedbackWidgetHarness'

/** A container `px` wide (jsdom has no layout), set in the widget's realm before init and undone after the test. */
function atWidth(px: number): string {
  return "var widthWas = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'); " +
    `Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: function () { return ${String(px)}; } }); ` +
    "document.body.__vocWide = function () { if (widthWas) Object.defineProperty(HTMLElement.prototype, 'clientWidth', widthWas); else delete HTMLElement.prototype.clientWidth; };"
}

afterEach(() => {
  const wide: unknown = Reflect.get(document.body, '__vocWide')
  if (typeof wide === 'function') Reflect.apply(wide, undefined, [])
  Reflect.deleteProperty(document.body, '__vocWide')
  resetWidgetPage()
})

const PHASES = [
  { code: 'intro', label: en('Introduction') },
  { code: 'lab', label: en('Hands-on lab') },
  { code: 'wrap', label: en('Wrap-up') },
]
const SCALE = [
  { code: 'needs', label: en('Needs improvement'), score: 1 },
  { code: 'ok', label: en('Satisfactory'), score: 2 },
  { code: 'very', label: en('Very effective'), score: 3 },
  { code: 'top', label: en('Exceptional'), score: 4 },
]

function matrix(extra: Record<string, unknown> = {}): Question {
  return {
    id: 'q_phases', type: 'matrix', headline: en('How was each phase?'), required: true, rows: PHASES, columns: SCALE,
    shuffle_rows: false, display: 'auto', ...extra,
  }
}

const rowGroups = (container: HTMLElement): HTMLElement[] => [...screen(container).querySelectorAll<HTMLElement>('.voc-matrix-row')]
const rowCodes = (container: HTMLElement): string[] => rowGroups(container).map((group) => group.dataset.row ?? '')
/** The words of the element a row's radio group is labelled by. */
const rowName = (container: HTMLElement, group: HTMLElement): string =>
  container.shadowRoot?.getElementById(group.getAttribute('aria-labelledby') ?? '')?.textContent ?? ''
const byWord = (a: string, b: string) => a.localeCompare(b)

describe('a matrix draws a grid where the form is wide enough', () => {
  it('heads the grid with the column labels (hidden from screen readers) over one radio group per row', async () => {
    const container = await renderWidget(form([matrix()]))
    const head = screen(container).querySelector<HTMLElement>('.voc-matrix-grid .voc-matrix-head')

    expect([...(head?.children ?? [])].map((cell) => cell.textContent)).toStrictEqual(['', ...SCALE.map((c) => c.label.en)])
    expect(head?.getAttribute('aria-hidden')).toBe('true')
    expect(rowGroups(container).map((group) => [group.getAttribute('role'), rowName(container, group), group.getAttribute('aria-required')]))
      .toStrictEqual([['radiogroup', 'Introduction', 'true'], ['radiogroup', 'Hands-on lab', 'true'], ['radiogroup', 'Wrap-up', 'true']])
  })

  it('names every radio with its row and its column, one radio group (one name) per row', async () => {
    const container = await renderWidget(form([matrix()]))
    const first = choice(container, 'Introduction: Exceptional')
    const sameRow = choice(container, 'Introduction: Needs improvement')
    const otherRow = choice(container, 'Wrap-up: Exceptional')

    expect([first.type, first.value, first.name === sameRow.name, first.name === otherRow.name]).toStrictEqual(['radio', 'top', true, false])
    expect(screen(container).querySelectorAll('.voc-matrix-row input[type="radio"]')).toHaveLength(12)
  })

  it('stacks the rows past seven columns, and when asked to', async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ code: `c${String(i)}`, label: en(`Point ${String(i)}`) }))
    const many = await renderWidget(form([matrix({ columns: eight })]))
    const manyStacked = screen(many).querySelector('.voc-matrix-stacked') !== null
    const forced = await renderWidget(form([matrix({ display: 'stacked' })]))

    expect(manyStacked).toBe(true)
    expect(screen(forced).querySelector('.voc-matrix-head')).toBeNull()
    expect([...rowGroups(forced)[1]?.querySelectorAll('.voc-opt') ?? []].map((label) => label.textContent))
      .toStrictEqual(SCALE.map((c) => `Hands-on lab: ${c.label.en ?? ''}`))
  })

  it('keeps a forced grid inside its own scroll box', async () => {
    const container = await renderWidget(form([matrix({ display: 'grid' })]), {}, { beforeInit: atWidth(375) })

    expect(screen(container).querySelector<HTMLElement>('.voc-matrix-grid')?.style.overflowX).toBe('auto')
  })
})

describe('a matrix on a phone', () => {
  it('stacks the rows at 375 px: a label, then the columns as full-width rows, nothing wider than the screen', async () => {
    const container = await renderWidget(form([matrix()]), {}, { beforeInit: atWidth(375) })
    const stacked = screen(container).querySelector<HTMLElement>('.voc-matrix-stacked')
    const options = [...stacked?.querySelectorAll<HTMLElement>('.voc-opt') ?? []]

    expect([stacked?.style.display, stacked?.style.flexDirection, stacked?.style.overflowX]).toStrictEqual(['flex', 'column', ''])
    expect(options.map((label) => [label.style.width, label.style.minHeight])).toStrictEqual(Array.from({ length: 12 }, () => ['100%', '48px']))
    expect(screen(container).querySelector('.voc-matrix-head')).toBeNull()
  })
})

describe('answering a matrix', () => {
  it('waits on a keyboard pick (no auto-advance), and asks for every row of a required matrix, focusing the first left out', async () => {
    const container = await renderWidget(form([matrix(), openText('q_next', 'Anything else?')]))
    pickByKey(container, 'Introduction: Exceptional')
    pressIn(container, '.voc-matrix-row input', 'Enter')

    expect(heading(container)).toBe('How was each phase?')
    expect(errorText(container)).toBe('✕ Answer every row to continue.')
    expect(focused(container)).toBe(choice(container, 'Hands-on lab: Needs improvement'))
  })

  it('never moves on after a tap either: a matrix takes several picks', async () => {
    const container = await renderWidget(form([matrix(), openText('q_next', 'Anything else?')]))
    pickByPointer(container, 'Introduction: Satisfactory')
    await new Promise((resolve) => { setTimeout(resolve, 400) })

    expect(heading(container)).toBe('How was each phase?')
  })

  it('sends {rows: {row: column}} in the question\'s row order, whatever order the rows were answered in', async () => {
    const container = await renderWidget(form([matrix()]))
    pickByKey(container, 'Wrap-up: Very effective')
    pickByKey(container, 'Introduction: Satisfactory')
    pickByKey(container, 'Introduction: Exceptional')
    pickByKey(container, 'Hands-on lab: Needs improvement')
    clickNext(container)
    const body = await submitted()

    expect(answersOf(body)).toStrictEqual({ q_phases: { rows: { intro: 'top', lab: 'needs', wrap: 'very' } } })
    expect(JSON.stringify(answersOf(body))).toBe('{"q_phases":{"rows":{"intro":"top","lab":"needs","wrap":"very"}}}')
  })

  it('takes an optional matrix left blank, and asks for min_rows once a row is answered', async () => {
    const blank = await renderWidget(form([matrix({ required: false, min_rows: 2 })]))
    clickNext(blank)
    const sent = await submitted()
    const partial = await renderWidget(form([matrix({ required: false, min_rows: 2 })]))
    pickByKey(partial, 'Hands-on lab: Satisfactory')
    clickNext(partial)

    expect(answersOf(sent)).toStrictEqual({})
    expect(errorText(partial)).toBe('✕ Answer at least 2 rows to continue.')
    expect(focused(partial)).toBe(choice(partial, 'Introduction: Needs improvement'))
  })

  it('sends the rows answered of an optional matrix without min_rows', async () => {
    const container = await renderWidget(form([matrix({ required: false })]))
    pickByKey(container, 'Hands-on lab: Satisfactory')
    clickNext(container)

    expect(answersOf(await submitted())).toStrictEqual({ q_phases: { rows: { lab: 'ok' } } })
  })

  it('follows a "skipped" rule of an optional matrix and a "submitted" one of an answered matrix', async () => {
    const logic = [{ when: { op: 'skipped' }, then: { jump_to: 'q_why' } }, { when: { op: 'submitted' }, then: { jump_to: 'q_more' } }]
    const questions = [matrix({ required: false, logic }), openText('q_more', 'Tell us more'), openText('q_why', 'Why skip it?')]
    const skipped = await renderWidget(form(questions))
    clickNext(skipped)
    const afterSkip = heading(skipped)
    const answered = await renderWidget(form(questions))
    pickByKey(answered, 'Wrap-up: Exceptional')
    clickNext(answered)

    expect([afterSkip, heading(answered)]).toStrictEqual(['Why skip it?', 'Tell us more'])
  })

  it('words its refusals in the form\'s language', async () => {
    const pl = { pl: 'Jak oceniasz każdy etap?' }
    const container = await renderWidget(form([matrix({ headline: pl, rows: [{ code: 'a', label: { pl: 'Wstęp' } }, { code: 'b', label: { pl: 'Warsztat' } }], columns: [{ code: 'x', label: { pl: 'Słabo' } }, { code: 'y', label: { pl: 'Dobrze' } }] })], { language: 'pl', languages: ['pl'] }))
    pickByKey(container, 'Wstęp: Dobrze')
    clickNext(container)

    expect(errorText(container)).toBe('✕ Odpowiedz w każdym wierszu, aby przejść dalej.')
  })
})

describe('shuffle_rows', () => {
  const MANY = Array.from({ length: 8 }, (_, i) => ({ code: `r${String(i)}`, label: en(`Row ${String(i)}`) }))
  const CODES = MANY.map((row) => row.code)
  const SHUFFLED = form([matrix({ rows: MANY, shuffle_rows: true })], { enabled: false })

  function orderWithSeed(seed: number): string[] {
    const container = renderPreview(SHUFFLED, { preview: { config: SHUFFLED, seed } })
    return rowCodes(container)
  }

  it('shuffles the rows by the preview\'s seed: the same order for the same seed, another for another', () => {
    const first = orderWithSeed(42)
    const again = orderWithSeed(42)
    const other = orderWithSeed(7)

    expect(again).toStrictEqual(first)
    expect([first.join() === CODES.join(), other.join() === first.join()]).toStrictEqual([false, false])
    expect([...first].sort(byWord)).toStrictEqual([...CODES].sort(byWord))
  })

  it('keeps its order across a draft update while the rows are the same, and shows the rows in order when off', () => {
    const container = renderPreview(SHUFFLED, { preview: { config: SHUFFLED, seed: 42 } })
    const before = rowCodes(container)
    handle().update(form([matrix({ rows: MANY, shuffle_rows: true, headline: en('Renamed') })], { enabled: false }))
    const kept = rowCodes(container)
    handle().update(form([matrix({ rows: MANY })], { enabled: false }))

    expect(kept).toStrictEqual(before)
    expect(rowCodes(container)).toStrictEqual(CODES)
  })
})
