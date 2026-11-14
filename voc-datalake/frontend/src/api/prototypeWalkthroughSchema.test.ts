/**
 * The walkthrough's boundary (docs/prototype-builder.md Part 1): an answer's steps are kept only when the page can
 * show them (a title, a text, and a selector or a position), at most ten; and the editor is told which part of a
 * step still keeps it from being saved.
 */
import { describe, expect, it } from 'vitest'
import { normalizeWalkthroughSteps, stepProblem } from './prototypeWalkthroughSchema'

const ANCHOR = { route: '/checkout', bbox: { x: 0, y: 0.5, w: 1, h: 0.25 } }

describe('normalizeWalkthroughSteps', () => {
  it('keeps the steps the page can show, trimmed, and drops the rest', () => {
    expect(normalizeWalkthroughSteps({ steps: [
      { title: ' Order ', body: 'Its date.', selector: '#order' },
      { title: 'Pay', body: 'The total.', anchor: ANCHOR },
      { title: '', body: 'No title.', selector: '#a' },
      { title: 'Nowhere', body: 'Points at nothing.' },
      { title: 'Off screen', body: 'A box past the edge.', anchor: { route: '', bbox: { x: 2, y: 0, w: 0, h: 0 } } },
      'not a step',
    ] })).toStrictEqual([
      { title: 'Order', body: 'Its date.', selector: '#order' },
      { title: 'Pay', body: 'The total.', anchor: ANCHOR },
    ])
  })

  it('keeps at most ten steps, and an answer without a list is none', () => {
    const many = Array.from({ length: 12 }, (_, n) => ({ title: `Step ${String(n)}`, body: 'Text.', selector: '#a' }))
    expect([normalizeWalkthroughSteps({ steps: many }).length, normalizeWalkthroughSteps({ steps: 'x' }), normalizeWalkthroughSteps(null)])
      .toStrictEqual([10, [], []])
  })
})

describe('stepProblem', () => {
  it.each([
    [{ title: ' ', body: 'Text.', selector: '#a' }, 'title'],
    [{ title: 'Order', body: '', selector: '#a' }, 'body'],
    [{ title: 'Order', body: 'Text.', selector: '' }, 'anchor'],
    [{ title: 'Order', body: 'Text.', anchor: ANCHOR }, null],
    [{ title: 'Order', body: 'Text.', selector: '#a' }, null],
  ])('%o: %s', (step, problem) => {
    expect(stepProblem(step)).toBe(problem)
  })
})
