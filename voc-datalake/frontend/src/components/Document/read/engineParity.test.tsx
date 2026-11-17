/**
 * The two engines read one text alike (§6.5 "read and edit render differently"): the light reader and the canvas give
 * the same heading ids (deep links, Contents) and the same comment-anchor text (components/DocumentComments/anchors.ts),
 * so a thread anchored on one engine is found on the other.
 */
import { render } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'
import { indexText } from '../../DocumentComments/anchors'
import { headlessEditor } from '../edit/editor/headless-editor-fixtures'
import { headingsOf } from '../edit/editor/headingIds'
import { largeMarkdown } from '../edit/markdown/large-document-fixtures'
import MarkdownRead from './MarkdownRead'
import { markdownPolicy } from './markdownPolicy'
import type { OutlineItem } from '../types'

/** What the canvas keeps as raw source, callouts both ways, repeated and formatted headings, nesting. */
const TRICKY = [
  '# Launch plan',
  'A paragraph with <kbd>raw</kbd> HTML, a footnote[^1] and a [reference link][ref].',
  '<details>\n<summary>More</summary>\n\nHidden.\n</details>',
  '[^1]: The footnote text.',
  '[ref]: https://example.com/ref',
  '## Goals',
  '> [!WARNING]\n> Watch the **budget**.',
  '> [!TIP]\n>\n> The marker on its own line.',
  '## Goals',
  '### The `eta` field and *its* [link](https://example.com)',
  '- one\n  - nested\n- two',
  '- [ ] open task\n- [x] done task',
  '| A | B |\n| --- | --- |\n| 1 | 2 |',
  'Line one  \nline two',
].join('\n\n')

function readerRoot(source: string): HTMLElement {
  const { container } = render(<MemoryRouter><MarkdownRead source={source} policy={markdownPolicy.stored} /></MemoryRouter>)
  return container
}

const headingIds = (root: HTMLElement) => [...root.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) => heading.id)

describe('the two engines', () => {
  it.each([['the tricky constructs', TRICKY], ['the large document', largeMarkdown(20_000)]])(
    'give %s the same heading ids', (_name, source) => {
      expect(headingIds(readerRoot(source))).toStrictEqual(headingsOf(headlessEditor(source).state.doc).map((heading) => heading.id))
    },
  )

  it.each([['the tricky constructs', TRICKY], ['the large document', largeMarkdown(20_000)]])(
    'index %s as the same comment-anchor text', (_name, source) => {
      // The reader's markup ends with a line break between blocks: a trailing space no quote can hold.
      expect(indexText(readerRoot(source)).text.trimEnd()).toBe(indexText(headlessEditor(source).view.dom).text)
    },
  )

  it('report the same Contents (h1–h3)', () => {
    const onOutline = vi.fn<(items: readonly OutlineItem[]) => void>()
    render(<MemoryRouter><MarkdownRead source={TRICKY} policy={markdownPolicy.stored} onOutline={onOutline} /></MemoryRouter>)
    const canvas = headingsOf(headlessEditor(TRICKY).state.doc).filter((heading) => heading.level <= 3)

    expect(onOutline).toHaveBeenLastCalledWith(canvas.map(({ id, level, text }) => ({ id, level, text })))
  })
})
