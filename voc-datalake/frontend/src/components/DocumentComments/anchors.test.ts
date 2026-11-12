/**
 * Text-quote anchors over a rendered document: whitespace-collapsed indexing, choosing the
 * right occurrence of a repeated quote by its prefix / suffix, re-anchoring on a newer version
 * (the quote moved or the whitespace changed), and the anchor a selection makes.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { anchorOfSelection, anchorRange, indexText } from './anchors'
import type { TextQuoteAnchor } from '../../api/documentReviewSchema'

/** Mounts `html`; blocks are separated by a newline like ReactMarkdown's output. */
function rendered(html: string): HTMLElement {
  const root = document.createElement('div')
  root.innerHTML = html.replaceAll('><', '>\n<')
  document.body.append(root)
  return root
}

function byId(root: Element, id: string): Element {
  const element = root.querySelector(`#${id}`)
  if (element === null) throw new Error(`no #${id} in the fixture`)
  return element
}

afterEach(() => {
  document.body.innerHTML = ''
  globalThis.getSelection()?.removeAllRanges()
})

const anchor = (exact: string, prefix = '', suffix = ''): TextQuoteAnchor => ({ exact, prefix, suffix, heading: '' })

/** The text a range covers and the paragraph it starts in. */
function located(range: Range | null): { text: string; in: string } | null {
  if (range === null) return null
  return { text: range.toString(), in: range.startContainer.parentElement?.id ?? '' }
}

/** The first text node under `element`. */
function textIn(element: Element): ChildNode {
  const node = element.firstChild
  if (node === null) throw new Error('no text to select')
  return node
}

/** Selects the `[start, end)` characters of the first text node under `element`. */
function select(element: Element, start: number, end: number): Selection {
  const node = textIn(element)
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const selection = globalThis.getSelection()
  if (selection === null) throw new Error('no selection support')
  selection.removeAllRanges()
  selection.addRange(range)
  return selection
}

describe('indexText', () => {
  it('collapses whitespace runs across text nodes and drops leading space', () => {
    const root = rendered('<p>  Fast\n\n delivery</p><p>   matters  </p>')
    expect(indexText(root).text).toBe('Fast delivery matters ')
  })

  it('keeps for every character the node it came from (a block break points at the text after it)', () => {
    const root = document.createElement('div')
    root.innerHTML = '<p>ab</p><p>cd</p>'
    expect(indexText(root).sources.map((source) => source.node.data)).toStrictEqual(['ab', 'ab', 'cd', 'cd', 'cd'])
  })

  it('separates blocks with one space even with no whitespace between them (the canvas DOM)', () => {
    const canvas = document.createElement('div')
    canvas.innerHTML = '<h2>Customer problem</h2><p>Customers <strong>wait</strong> two weeks.<br>Then more.</p>'
      + '<ul><li><p>One</p></li><li><p>Two</p></li></ul><table><tbody><tr><td><p>A</p></td><td><p>B</p></td></tr></tbody></table>'
    const markdown = rendered('<h2>Customer problem</h2><p>Customers <strong>wait</strong> two weeks.<br>Then more.</p>'
      + '<ul><li>One</li><li>Two</li></ul><table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>')
    expect([indexText(canvas).text, indexText(markdown).text.trim()]).toStrictEqual([
      'Customer problem Customers wait two weeks. Then more. One Two A B',
      'Customer problem Customers wait two weeks. Then more. One Two A B',
    ])
  })

  it('leaves out the editor chrome marked data-anchor-skip (handles, labels)', () => {
    const canvas = document.createElement('div')
    canvas.innerHTML = '<div data-anchor-skip contenteditable="false">Drag</div><p>Refunds</p>'
      + '<pre><span data-anchor-skip>typescript</span><code>const a = 1</code></pre>'
      + '<blockquote><p><span data-anchor-skip>Note</span>Keep <em data-anchor-skip>label</em>it short</p></blockquote>'
    expect(indexText(canvas).text).toBe('Refunds const a = 1 Keep it short')
  })
})

describe('anchorRange', () => {
  it('finds a quote that appears once', () => {
    const root = rendered('<p id="p1">Customers wait two weeks for a refund.</p>')
    expect(located(anchorRange(root, anchor('two weeks')))).toStrictEqual({ text: 'two weeks', in: 'p1' })
  })

  it('picks the repeated quote whose prefix and suffix match (context keeps its edge spaces)', () => {
    const root = rendered('<p id="a">The app is slow on login.</p><p id="b">The checkout is slow on mobile.</p>')
    const range = anchorRange(root, anchor('is slow on', 'The checkout ', ' mobile.'))
    expect(located(range)).toStrictEqual({ text: 'is slow on', in: 'b' })
  })

  it('re-anchors on a newer version where the quote moved and the whitespace changed', () => {
    const root = rendered('<h2>New intro</h2><p id="moved">We   promise\n a refund within  three days.</p>')
    const range = anchorRange(root, anchor('a refund within three days', 'We promise ', '.'))
    expect(range?.toString().replaceAll(/\s+/g, ' ')).toBe('a refund within three days')
  })

  it('finds the quote by its text alone when the context around it changed', () => {
    const root = rendered('<p id="p">Rewritten sentence: refunds take three days now.</p>')
    expect(located(anchorRange(root, anchor('three days', 'Old context ', ' old tail')))).toStrictEqual({ text: 'three days', in: 'p' })
  })

  it('is null when the quote is no longer in this version (the thread shows as outdated)', () => {
    const root = rendered('<p>Nothing about refunds here.</p>')
    expect(anchorRange(root, anchor('three days'))).toBeNull()
  })

  it('is null for an empty quote', () => {
    expect(anchorRange(rendered('<p>Text</p>'), anchor('   '))).toBeNull()
  })

  it('treats regular-expression characters in a quote literally', () => {
    const root = rendered('<p id="p">Price (USD) is $9.99?</p>')
    expect(located(anchorRange(root, anchor('(USD) is $9.99?')))).toStrictEqual({ text: '(USD) is $9.99?', in: 'p' })
  })
})

describe('anchorOfSelection', () => {
  it('records the quote, its context and the heading it sits under', () => {
    const root = rendered('<h2>Customer problem</h2><p id="p">Customers wait two weeks for a refund.</p>')
    expect(anchorOfSelection(root, select(byId(root, 'p'), 15, 24))).toStrictEqual({
      exact: 'two weeks',
      prefix: 'Customer problem Customers wait ',
      suffix: ' for a refund.',
      heading: 'Customer problem',
    })
  })

  it('makes the same anchor on the canvas DOM as on the rendered Markdown, chrome aside', () => {
    const canvas = document.createElement('div')
    canvas.innerHTML = '<h2 id="h"><span data-anchor-skip>⋮⋮</span>Customer problem</h2><p id="p">Customers wait two weeks for a refund.</p>'
    document.body.append(canvas)
    expect(anchorOfSelection(canvas, select(byId(canvas, 'p'), 15, 24))).toStrictEqual({
      exact: 'two weeks',
      prefix: 'Customer problem Customers wait ',
      suffix: ' for a refund.',
      heading: 'Customer problem',
    })
  })

  it('records a selection that crosses two blocks with the space between them', () => {
    const canvas = document.createElement('div')
    canvas.innerHTML = '<p id="a">Refunds are slow.</p><p id="b">Customers wait.</p>'
    document.body.append(canvas)
    const selection = select(byId(canvas, 'a'), 12, 17)
    selection.getRangeAt(0).setEnd(textIn(byId(canvas, 'b')), 9)
    expect(anchorOfSelection(canvas, selection)?.exact).toBe('slow. Customers')
  })

  it('makes an anchor that finds the same text again', () => {
    const root = rendered('<p id="a">slow on login</p><p id="b">slow on mobile</p>')
    const made = anchorOfSelection(root, select(byId(root, 'b'), 0, 7)) ?? anchor('')

    expect(located(anchorRange(root, made))).toStrictEqual({ text: 'slow on', in: 'b' })
  })

  it('is null for no selection, a collapsed one, or one outside the document', () => {
    const root = rendered('<p id="p">Inside</p>')
    const outside = rendered('<p id="o">Outside</p>')
    expect([
      anchorOfSelection(root, null),
      anchorOfSelection(root, select(byId(root, 'p'), 2, 2)),
      anchorOfSelection(root, select(byId(outside, 'o'), 0, 3)),
    ]).toStrictEqual([null, null, null])
  })

  it('is null for a selection longer than 500 characters', () => {
    const root = rendered(`<p id="p">${'word '.repeat(150)}</p>`)
    expect(anchorOfSelection(root, select(byId(root, 'p'), 0, 600))).toBeNull()
  })
})
