/**
 * The comment rail around any document content (the slot): a quoted thread's bubble sits beside
 * its passage, measured from the margin's top; the passage is painted through the CSS Custom
 * Highlight API (the content's DOM untouched); a change of the content's DOM alone (no new
 * revision: the editor loading another text) moves a thread whose quote is gone to "Not found in
 * this version"; a draft closes with Escape.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useRef } from 'react'
import { selectText } from '../../test/selectText'
import CommentedDocument from './CommentedDocument'
import type { CommentedDocumentHandle } from './CommentedDocument'
import type { CommentActions } from './commentTypes'
import type { CommentThread } from '../../api/documentReviewSchema'

const QUOTED: CommentThread = {
  comment_id: 'c1', document_id: 'doc_1', version: 1, text: 'Which method?', status: 'open', flagged: false,
  anchor: { exact: 'two weeks', prefix: 'wait ', suffix: ' for', heading: '' },
  created_at: '2026-10-28T10:00:00Z', author: { kind: 'user', name: 'Rui' }, replies: [], from_review_link: false, addressed: null,
}

const ACTIONS: CommentActions = { create: () => Promise.resolve(), reply: () => Promise.resolve() }

class FakeHighlight {
  readonly ranges: Range[]
  constructor(...ranges: Range[]) {
    this.ranges = ranges
  }
}

const registry = new Map<string, FakeHighlight>()

function Harness({ revision = 'v1', threads = [QUOTED], onHandle }: Readonly<{
  revision?: string; threads?: readonly CommentThread[]; onHandle?: (handle: CommentedDocumentHandle | null) => void
}>) {
  const root = useRef<HTMLDivElement>(null)
  return (
    <CommentedDocument contentRoot={() => root.current} revision={revision} threads={threads} viewed={{ documentId: 'doc_1' }}
      actions={ACTIONS} canComment commentRef={onHandle}>
      <div ref={root} data-testid="content">
        <p>Customers wait two weeks for a refund.</p>
      </div>
    </CommentedDocument>
  )
}

/** Selects `[start, end)` of the content's paragraph. */
function selectRange(start: number, end: number): void {
  selectText(within(screen.getByTestId('content')).getByText(/Customers wait/), start, end)
}

/** Selects "two weeks" in the content. */
const selectQuote = () => selectRange(15, 24)

beforeEach(() => {
  registry.clear()
  vi.stubGlobal('CSS', { highlights: registry })
  vi.stubGlobal('Highlight', FakeHighlight)
  // The passage 120 px down the page, the margin (and the content) starting at 40 px.
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', { configurable: true, value: () => new DOMRect(0, 120, 50, 16) })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 40, 600, 800))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(Range.prototype, 'getBoundingClientRect')
  globalThis.getSelection()?.removeAllRanges()
})

describe('a quoted thread', () => {
  it('sits beside its passage, measured from the margin', async () => {
    render(<Harness />)

    const card = await screen.findByRole('article', { name: 'Comment by Rui' })
    expect(card.parentElement?.style.getPropertyValue('--bubble-top')).toBe('80px')
  })

  it('has its passage highlighted without touching the content', async () => {
    render(<Harness />)
    const before = screen.getByTestId('content').innerHTML

    await waitFor(() => expect(registry.get('voc-comment')?.ranges.map(String)).toStrictEqual(['two weeks']))
    expect(screen.getByTestId('content').innerHTML).toBe(before)
  })

  it('moves to "Not found in this version" when the content changes under it, revision or not', async () => {
    render(<Harness />)
    await screen.findByText('Which method?')
    const paragraph = within(screen.getByTestId('content')).getByText(/Customers wait/)

    paragraph.textContent = 'Customers wait for a refund.'

    const heading = await screen.findByText('Not found in this version')
    expect(heading.closest('section')).toHaveTextContent('Which method?')
  })
})

/** Renders the harness with its handle and selects the quote. */
function renderSelected() {
  const handle: { current: CommentedDocumentHandle | null } = { current: null }
  const user = userEvent.setup()
  render(<Harness onHandle={(value) => { handle.current = value }} />)
  selectQuote()
  return { handle, user }
}

/** Opens a draft on the quote through the handle; `text` is typed into it. */
async function openDraft(text?: string) {
  const { handle, user } = renderSelected()
  act(() => { handle.current?.commentOnSelection() })
  const box = await screen.findByLabelText('Add a comment')
  if (text !== undefined) await user.type(box, text)
  return { handle, user }
}

describe('a draft', () => {
  it('opens on the selection through the handle, beside it, and closes with Escape', async () => {
    const { handle, user } = renderSelected()

    expect(handle.current?.commentOnSelection()).toBe(true)
    const box = await screen.findByLabelText('Add a comment')
    expect(box.closest('.z-30')?.getAttribute('style')).toContain('--bubble-top: 80px')

    await user.keyboard('{Escape}')

    expect(screen.queryByLabelText('Add a comment')).not.toBeInTheDocument()
  })

  it('with text is never replaced by a second selection: it says so and takes the person back to it', async () => {
    const { handle } = await openDraft('How long?')
    selectRange(0, 9)

    act(() => { handle.current?.commentOnSelection() })

    expect(screen.getByText('Finish or cancel the comment you are writing first.')).toBeInTheDocument()
    expect(screen.getByLabelText('Add a comment')).toHaveValue('How long?')
    expect(screen.getByLabelText('Add a comment')).toHaveFocus()
    expect(screen.getByRole('complementary', { name: 'Comments' }).querySelector('blockquote')).toHaveTextContent('two weeks')
  })

  it('nor by "Comment on the whole document"', async () => {
    const { user } = await openDraft('How long?')

    await user.click(screen.getByRole('button', { name: 'Comment on the whole document' }))

    expect(screen.getByLabelText('Add a comment')).toHaveValue('How long?')
    expect(screen.queryByText('Comment on the whole document', { selector: 'p' })).not.toBeInTheDocument()
    expect(screen.getByText('Finish or cancel the comment you are writing first.')).toBeInTheDocument()
  })

  it('still empty moves to the newer selection', async () => {
    const { handle } = await openDraft()
    selectRange(0, 9)

    act(() => { handle.current?.commentOnSelection() })

    expect(screen.getByRole('complementary', { name: 'Comments' }).querySelector('blockquote')).toHaveTextContent('Customers')
  })
})

describe('the layout', () => {
  it('keeps the text in the ~70ch reading column, with the rail beside it from xl up and under it below', async () => {
    render(<Harness />)
    await screen.findByRole('article', { name: 'Comment by Rui' })

    const column = screen.getByTestId('reading-column')
    expect(column).toHaveClass('max-w-[70ch]', 'min-w-0')
    expect(column.parentElement?.className).toBe('flex flex-col gap-6 xl:grid xl:grid-cols-[minmax(0,1fr)_18rem] xl:gap-8')
    // The bubbles sit beside their passages from xl up only: below, one stacked list in reading order.
    expect(screen.getByRole('article', { name: 'Comment by Rui' }).parentElement?.className)
      .toBe('xl:absolute xl:inset-x-0 xl:top-[var(--bubble-top)]')
  })
})

/** A second thread on "a refund", 20 px below "two weeks" in the stubbed layout. */
const NEARBY: CommentThread = {
  ...QUOTED, comment_id: 'c2', text: 'Which refund?', author: { kind: 'user', name: 'Ana' },
  anchor: { exact: 'a refund', prefix: 'for ', suffix: '.', heading: '' },
}

describe('two bubbles of nearby passages', () => {
  /** Each bubble's rendered height, by thread (jsdom lays nothing out). */
  const heights = new Map<string, number>()
  const observers: Array<{ callback: ResizeObserverCallback; observer: ResizeObserver }> = []
  /** What a ResizeObserver does when a box it observes changes size. */
  const resize = () => act(() => { observers.forEach(({ callback, observer }) => { callback([], observer) }) })

  beforeEach(() => {
    heights.clear()
    heights.set('c1', 200).set('c2', 120)
    observers.length = 0
    // "two weeks" 120 px down the page, "a refund" 140 px: 80 and 100 px below the margin's top (40 px).
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true, value(this: Range) { return new DOMRect(0, this.toString() === 'a refund' ? 140 : 120, 50, 16) },
    })
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function height(this: HTMLElement) {
      const id = this.querySelector<HTMLElement>(':scope > [data-thread-id]')?.dataset['threadId']
      return id === undefined ? 0 : heights.get(id) ?? 0
    })
    vi.stubGlobal('ResizeObserver', class FakeResizeObserver {
      constructor(callback: ResizeObserverCallback) { observers.push({ callback, observer: this }) }
      observe() { /* the test reports the resizes itself (resize) */ }
      unobserve() { /* as observe */ }
      disconnect() { /* as observe */ }
    })
  })

  const topOf = (name: string) => Number.parseFloat(
    screen.getByRole('article', { name }).parentElement?.style.getPropertyValue('--bubble-top') ?? 'NaN')

  it('are laid out from their measured heights: the lower one starts below the tall upper card, never over it', async () => {
    render(<Harness threads={[NEARBY, QUOTED]} />)
    await screen.findByRole('article', { name: 'Comment by Ana' })

    await waitFor(() => expect(topOf('Comment by Ana')).toBe(80 + 200 + 8))
    expect(topOf('Comment by Rui'), 'the upper one stays beside its passage').toBe(80)
  })

  it('move when the upper one grows (a reply box opening), and back up beside their passage when it shrinks', async () => {
    render(<Harness threads={[QUOTED, NEARBY]} />)
    await waitFor(() => expect(topOf('Comment by Ana')).toBe(288))

    heights.set('c1', 320)
    resize()
    await waitFor(() => expect(topOf('Comment by Ana')).toBe(80 + 320 + 8))

    heights.set('c1', 10)
    resize()
    await waitFor(() => expect(topOf('Comment by Ana')).toBe(100))
  })
})
