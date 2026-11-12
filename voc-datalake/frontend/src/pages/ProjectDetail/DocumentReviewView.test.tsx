/**
 * A PR/FAQ / PRD on the canvas with its comments in the project's document page: threads in the
 * margin beside their quote, on the whole document, or "Not found in this version" (also live, when
 * an edit removes a quote); the author and resolved filters; comment (from the canvas' floating bar,
 * from ⌘/Ctrl+Alt+M, on the whole document), reply, resolve and delete through the team routes; the
 * persona review for editors only, in the rail; the "Comments | Evidence" tabs; and the canvas shown,
 * never remounted, when comments cannot load.
 *
 * The canvas editor is a stand-in with the real one's props and handle (src/components/DocumentCanvas/editor/CanvasEditor.tsx): it renders
 * the Markdown's blocks as plain elements, an editor control marked data-anchor-skip, and a bar
 * button that calls `onCommentSelection`.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { stubRangeLayout } from '@test/stubRangeLayout'
import { selectText } from '@test/selectText'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { useAuthStore } from '../../store/authStore'
import { ignoreRejection } from '../../lib/rejections'
import { makeProject } from './project-detail-fixtures'
import { parsedJson } from '@test/jsonText'
import { asRecord } from '../../api/wireRecord'
import type { ProjectDocument } from '../../api/types'
import type { CanvasEditorHandle, CanvasEditorProps } from '../../components/DocumentCanvas/editor/CanvasEditor'
import type { ReviseCanvas } from '../../components/DocumentCanvas/revise/useRevisePass'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
const runAssistJob = vi.fn<() => Promise<unknown>>()
const editorProps = vi.fn<(props: CanvasEditorProps) => void>()
const clearSelection = vi.fn<() => void>()
vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))
vi.mock('../../api/assistJobs', () => ({ runAssistJob: () => runAssistJob() }))

const EDITED = '## Customer problem\n\nCustomers wait for a refund.'

vi.mock('../../components/DocumentCanvas/editor/CanvasEditor', async () => {
  const { useImperativeHandle, useRef, useState } = await import('react')
  function FakeCanvasEditor(props: CanvasEditorProps) {
    editorProps(props)
    const { markdown, editable, ariaLabel, onChange, onCommentSelection, handleRef } = props
    const root = useRef<HTMLDivElement>(null)
    const [text, setText] = useState(markdown)
    useImperativeHandle(handleRef, (): CanvasEditorHandle => ({
      root: () => root.current, getMarkdown: () => text, setMarkdown: setText, focus: () => root.current?.focus(),
      scrollToHeading: () => { /* no headings to scroll to in these specs */ }, clearSelection,
    }), [text])
    return (
      <div>
        <div ref={root} role="textbox" aria-label={ariaLabel} contentEditable={editable} suppressContentEditableWarning
          tabIndex={0} data-testid="fake-canvas">
          <div data-anchor-skip contentEditable={false}>Drag to move</div>
          {text.split('\n\n').map((block) => (block.startsWith('## ')
            ? <h2 key={block}>{block.slice(3)}</h2>
            : <p key={block}>{block}</p>))}
        </div>
        {onCommentSelection === undefined ? null : (
          <button type="button" onMouseDown={(event) => event.preventDefault()} onClick={onCommentSelection}>Bar comment</button>
        )}
        <button type="button" onClick={() => { setText(EDITED); onChange?.(EDITED) }}>Simulate an edit</button>
      </div>
    )
  }
  return { default: FakeCanvasEditor }
})

const { default: DocumentReviewView } = await import('./DocumentReviewView')
const { useCanvasDocument } = await import('../../components/DocumentCanvas/actions/useCanvasDocument')

const BASE = '/projects/proj_1/documents/doc_2'
const MARKDOWN = '## Customer problem\n\nCustomers wait two weeks for a refund.'
const DOCUMENT: ProjectDocument = {
  document_id: 'doc_2', document_type: 'prfaq', title: 'Faster refunds', content: MARKDOWN, created_at: '2026-10-28', version: 2,
}

const author = (kind: 'user' | 'persona' | 'reviewer', name: string, extra: Record<string, string> = {}) => ({ kind, name, ...extra })

function thread(id: string, extra: Record<string, unknown>) {
  return {
    comment_id: id, document_id: 'doc_2', version: 2, text: `Comment ${id}`, anchor: null, status: 'open', flagged: false,
    created_at: '2026-10-28T10:00:00Z', author: author('user', 'Rui', { sub: 'sub-rui' }), replies: [], from_review_link: false, ...extra,
  }
}

const anchored = (exact: string) => ({ exact, prefix: '', suffix: '', heading: '' })

const THREADS = [
  thread('c_whole', { text: 'Who is the customer?' }),
  thread('c_quote', { text: 'Name the refund method.', anchor: anchored('two weeks'), author: author('reviewer', 'sam@example.com') }),
  thread('c_gone', { text: 'Old wording', anchor: anchored('three months'), document_id: 'doc_1', version: 1,
    author: author('persona', 'Budget Priya', { persona_id: 'p1' }) }),
  thread('c_done', { text: 'Fixed typo', status: 'resolved' }),
]

/** A write's JSON body, as a record. */
const sentBody = (options?: RequestInit) => asRecord(parsedJson(options?.body)) ?? {}

function serve({ canEdit = true, threads = THREADS }: { canEdit?: boolean; threads?: unknown[] } = {}) {
  fetchApi.mockImplementation((endpoint, options) => {
    if (endpoint === `${BASE}/comments` && options?.method === undefined) {
      return Promise.resolve({ threads, share: null, can_edit: canEdit })
    }
    if (endpoint.endsWith('/comments/addressed')) return Promise.resolve({ threads: [] })
    // The page's Save (its own canvas): the next version, v3, with the content sent.
    if (endpoint === BASE && options?.method === 'PUT') {
      const { content } = sentBody(options)
      return Promise.resolve({ document: { ...DOCUMENT, document_id: 'doc_3', version: 3, content: typeof content === 'string' ? content : '' } })
    }
    return Promise.resolve({ thread: thread('c_new', {}) })
  })
}

function renderView({ hasPersonas = true, evidence, editable = true }: { hasPersonas?: boolean; evidence?: string; editable?: boolean } = {}) {
  const handleRef: { current: CanvasEditorHandle | null } = { current: null }
  const onChange = vi.fn<(markdown: string) => void>()
  const canvas: ReviseCanvas = { lastSaved: null, generation: 0, reloadLatest: vi.fn(), selectDoc: vi.fn(), markRevised: vi.fn() }
  const view = (lastSaved: ReviseCanvas['lastSaved'], generation = 0) => (
    <DocumentReviewView projectId="proj_1" document={DOCUMENT} markdown={MARKDOWN} hasPersonas={hasPersonas}
      editable={editable} onChange={onChange} handleRef={handleRef} evidence={evidence === undefined ? undefined : <p>{evidence}</p>}
      canvas={{ ...canvas, lastSaved, generation }} />
  )
  const { rerender } = renderWithQueryClient(view(null))
  /** The page's canvas saved `content` as `version` (its lastSaved). */
  const saved = (content: string, version: number) => rerender(view({
    document: { ...DOCUMENT, document_id: `doc_${String(version)}`, version, content }, content,
  }))
  /** The page's Discard: the stored text back in the editor (no onChange), a new generation of the canvas. */
  const discarded = () => {
    act(() => { handleRef.current?.setMarkdown(MARKDOWN) })
    rerender(view(null, 1))
  }
  return { handleRef, onChange, canvas, saved, discarded }
}

const threadBy = (name: string) => screen.findByRole('article', { name: `Comment by ${name}` })
const writes = () => fetchApi.mock.calls.filter(([, options]) => options?.method !== undefined)
const notFoundSection = () => screen.queryByRole('heading', { name: 'Not found in this version' })?.closest('section') ?? null

/** Selects `[start, end)` of the canvas paragraph that contains `text`. */
function selectInCanvas(text: string, start: number, end: number): void {
  selectText(within(screen.getByTestId('fake-canvas')).getByText(text), start, end)
}

const PARAGRAPH = 'Customers wait two weeks for a refund.'

beforeAll(() => stubRangeLayout())

beforeEach(() => {
  fetchApi.mockReset()
  runAssistJob.mockReset()
  editorProps.mockReset()
  clearSelection.mockReset()
  globalThis.getSelection()?.removeAllRanges()
  useAuthStore.getState().setUser({ username: 'rui', email: 'rui@example.com', groups: [], sub: 'sub-rui' })
  serve()
})

describe('the canvas', () => {
  it('shows the document on the canvas with its title, editable, and hands the page the editor handle', async () => {
    const { handleRef } = renderView()

    expect(await screen.findByRole('textbox', { name: 'Faster refunds' })).toHaveTextContent(PARAGRAPH)
    expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ markdown: MARKDOWN, editable: true }))
    expect(handleRef.current?.getMarkdown()).toBe(MARKDOWN)
  })

  it('reads like every other document: the canvas reading typography, in the ~70ch column', async () => {
    renderView()

    const canvas = await screen.findByTestId('fake-canvas')
    expect(editorProps).toHaveBeenLastCalledWith(expect.objectContaining({ className: 'md-content leading-7!' }))
    expect(canvas.closest('[data-testid="reading-column"]')).toHaveClass('max-w-[70ch]')
    expect(screen.getByRole('complementary', { name: 'Comments' }).closest('[data-testid="reading-column"]')).toBeNull()
  })

  it('passes every edit on to the page', async () => {
    const user = userEvent.setup()
    const { onChange } = renderView()

    await user.click(await screen.findByRole('button', { name: 'Simulate an edit' }))

    expect(onChange).toHaveBeenCalledWith(EDITED)
  })
})

describe('the comment threads', () => {
  it('places whole-document, quoted and no-longer-found threads, hiding resolved ones', async () => {
    renderView()

    expect(await screen.findByText('Name the refund method.')).toBeInTheDocument()
    expect(notFoundSection()).toHaveTextContent('Old wording')
    expect(screen.getByRole('heading', { name: 'On the whole document' }).closest('section')).toHaveTextContent('Who is the customer?')
    expect(screen.queryByText('Fixed typo')).not.toBeInTheDocument()
  })

  it('marks a thread made on an older version', async () => {
    renderView()

    expect(await threadBy('Budget Priya')).toHaveTextContent('On v1')
  })

  it('shows resolved threads on request', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText('Who is the customer?')

    await user.click(screen.getByRole('checkbox', { name: 'Show resolved' }))

    expect(await screen.findByText('Fixed typo')).toBeInTheDocument()
  })

  it('moves a thread to "Not found in this version" as soon as an edit removes its quote', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText('Name the refund method.')
    expect(notFoundSection()).not.toHaveTextContent('Name the refund method.')

    await user.click(screen.getByRole('button', { name: 'Simulate an edit' }))

    await waitFor(() => expect(notFoundSection()).toHaveTextContent('Name the refund method.'))
  })
})

describe('commenting', () => {
  it('comments on the whole document', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText('Who is the customer?')

    await user.click(screen.getByRole('button', { name: 'Comment on the whole document' }))
    await user.type(screen.getByLabelText('Add a comment'), 'Add a FAQ on fees')
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    await waitFor(() => expect(writes()).toStrictEqual([
      [`${BASE}/comments`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Add a FAQ on fees' }) })],
    ]))
  })

  it('comments on the passage selected on the canvas, from the floating bar, anchored in the reading text', async () => {
    const user = userEvent.setup()
    renderView()
    await screen.findByText('Who is the customer?')
    selectInCanvas(PARAGRAPH, 15, 24)

    await user.click(screen.getByRole('button', { name: 'Bar comment' }))
    await user.type(screen.getByLabelText('Add a comment'), 'How long exactly?')
    expect(clearSelection, 'the passage stays selected while the comment is written').not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Comment' }))

    const anchor = { exact: 'two weeks', prefix: 'Customer problem Customers wait ', suffix: ' for a refund.', heading: 'Customer problem' }
    await waitFor(() => expect(writes()).toStrictEqual([
      [`${BASE}/comments`, expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'How long exactly?', anchor }) })],
    ]))
    // The selection is consumed: the canvas collapses it, so its floating bar closes.
    await waitFor(() => expect(clearSelection).toHaveBeenCalledTimes(1))
  })

  it('starts the same comment from the keyboard: Ctrl+Alt+M on the canvas', async () => {
    renderView()
    await screen.findByText('Who is the customer?')
    selectInCanvas(PARAGRAPH, 15, 24)

    fireEvent.keyDown(screen.getByTestId('fake-canvas'), { key: 'µ', code: 'KeyM', ctrlKey: true, altKey: true })

    expect(await screen.findByLabelText('Add a comment')).toHaveFocus()
    expect(screen.getByRole('complementary', { name: 'Comments' }).querySelector('blockquote')).toHaveTextContent('two weeks')
  })

  it('says to select a passage first when the shortcut finds no selection', async () => {
    renderView()
    await screen.findByText('Who is the customer?')

    fireEvent.keyDown(screen.getByTestId('fake-canvas'), { key: 'm', code: 'KeyM', metaKey: true, altKey: true })

    expect(await screen.findByText(/Select a passage of the document first/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Add a comment')).not.toBeInTheDocument()
  })

  it('replies to a thread', async () => {
    const user = userEvent.setup()
    renderView()
    const card = await threadBy('sam@example.com')

    await user.click(within(card).getByRole('button', { name: 'Reply' }))
    await user.type(within(card).getByLabelText('Write a reply'), 'Bank transfer')
    await user.click(within(card).getByRole('button', { name: 'Reply' }))

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(`${BASE}/comments/c_quote/replies`,
      expect.objectContaining({ method: 'POST', body: JSON.stringify({ text: 'Bank transfer' }) })))
  })

  it('resolves a thread', async () => {
    const user = userEvent.setup()
    renderView()

    await user.click(within(await threadBy('sam@example.com')).getByRole('button', { name: 'Resolve' }))

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(`${BASE}/comments/c_quote/resolve`, expect.objectContaining({ method: 'POST' })))
  })

  it('lets a viewer delete only their own threads', async () => {
    serve({ canEdit: false })
    renderView()

    expect(within(await threadBy('Rui')).getByRole('button', { name: 'Delete comment' })).toBeInTheDocument()
    expect(within(await threadBy('sam@example.com')).queryByRole('button', { name: 'Delete comment' })).not.toBeInTheDocument()
  })
})

describe('the persona review, in the rail', () => {
  it('asks personas to review and says how many comments they filed', async () => {
    runAssistJob.mockResolvedValue({ filed: 3, personas: [{ persona_id: 'p1' }, { persona_id: 'p2' }] })
    const user = userEvent.setup()
    renderView()

    const rail = await screen.findByRole('complementary', { name: 'Comments' })
    await user.click(await within(rail).findByRole('button', { name: 'Ask personas to review' }))

    expect(await within(rail).findByText('3 comments filed (2 personas asked)')).toHaveAttribute('role', 'status')
  })

  it('shows the review running, with the button disabled', async () => {
    runAssistJob.mockReturnValue(new Promise<never>(() => { /* the review never ends here */ }))
    const user = userEvent.setup()
    renderView()

    await user.click(await screen.findByRole('button', { name: 'Ask personas to review' }))

    expect(screen.getByRole('button', { name: 'Personas are reading…' })).toBeDisabled()
  })

  it('says when the review failed', async () => {
    runAssistJob.mockRejectedValue(new Error('boom'))
    const user = userEvent.setup()
    renderView()

    await user.click(await screen.findByRole('button', { name: 'Ask personas to review' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The persona review failed. Please try again.')
  })

  it('cannot ask personas when the project has none', async () => {
    renderView({ hasPersonas: false })

    expect(await screen.findByRole('button', { name: 'Ask personas to review' })).toBeDisabled()
  })

  it('is not offered to a viewer, and sharing is never here (the page\'s action bar has it)', async () => {
    serve({ canEdit: false })
    renderView()
    await screen.findByText('Who is the customer?')

    expect(screen.queryByRole('button', { name: 'Ask personas to review' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Share for review|Review link/ })).not.toBeInTheDocument()
  })
})

describe('Revise from comments', () => {
  const QUOTE_CHANGE = { change_id: 'ch_1', thread_ids: ['c_quote'], before: 'two weeks', after: 'five days', reason: 'Answers the method question' }
  // `job_id`: the pass's job, as reviseFromComments sets it from the job it polled (runAssistJob is mocked whole here).
  const revised = (outcome: string, extra: Record<string, unknown> = {}) => ({
    outcome, base_document_id: 'doc_2', base_version: 2, recommendations: [{ thread_id: 'c_done', text: 'Say which typo was fixed.' }],
    changes: outcome === 'recommendations' ? [] : [QUOTE_CHANGE], applied_version: null, addressed_thread_ids: [], dropped: 0,
    job_id: 'job_rev_1', ...extra,
  })
  const REPLIED = { replies: [{ reply_id: 'r1', author: author('user', 'Rui'), text: 'Bank transfer', flagged: false, at: '' }] }
  const rail = () => screen.findByRole('complementary', { name: 'Comments' })

  beforeAll(() => { stubElementScrollIntoView() })

  it('sits beside "Ask personas to review", disabled with the reason until a thread is answered', async () => {
    serve({ threads: [thread('c_whole', { text: 'Who is the customer?' })] })
    renderView()

    const button = await within(await rail()).findByRole('button', { name: 'Revise from comments' })
    await waitFor(() => expect(button).toBeDisabled())
    expect(button).toHaveAccessibleDescription('Reply to a comment or resolve it first.')
    expect(within(await rail()).getByRole('button', { name: 'Ask personas to review' })).toBeInTheDocument()
  })

  it('is not offered to a viewer, nor on a read-only canvas', async () => {
    serve({ canEdit: false })
    renderView()
    await screen.findByText('Who is the customer?')
    expect(screen.queryByRole('button', { name: 'Revise from comments' })).not.toBeInTheDocument()
  })

  /** Renders (`mount`), waits for "Revise from comments" to be enabled, and starts a pass. */
  async function startRevising<T extends object>(mount: () => T) {
    const user = userEvent.setup()
    const view = mount()
    const button = await within(await rail()).findByRole('button', { name: 'Revise from comments' })
    await waitFor(() => expect(button).toBeEnabled())
    await user.click(button)
    return { ...view, user, button }
  }

  /** Starts a pass that proposes QUOTE_CHANGE and accepts it on the canvas. */
  async function acceptTheProposal<T extends object>(mount: () => T) {
    serve({ threads: [...THREADS.slice(0, 1), thread('c_quote', { text: 'Name the refund method.', anchor: anchored('two weeks'), ...REPLIED })] })
    runAssistJob.mockResolvedValue(revised('proposal'))
    const started = await startRevising(mount)
    const review = await screen.findByRole('region', { name: 'Suggested changes' })
    await started.user.click(within(review).getByRole('button', { name: 'Accept change 1' }))
    return { ...started, review }
  }
  const NEXT = '## Customer problem\n\nCustomers wait five days for a refund.'
  const addressedWrites = () => writes().filter(([endpoint]) => endpoint.endsWith('/addressed'))
  /** The one "addressed" write: c_quote marked (or unmarked) on `documentId`. */
  const expectAddressed = (documentId: string, addressed: boolean) => waitFor(() => expect(addressedWrites()).toStrictEqual([
    [`/projects/proj_1/documents/${documentId}/comments/addressed`, expect.objectContaining({
      method: 'POST', body: JSON.stringify({ thread_ids: ['c_quote'], addressed }),
    })],
  ]))
  /** Answers `route` first (a value), every other call as before. */
  const answerAlso = (route: (endpoint: string, options?: RequestInit) => unknown) => {
    const answers = fetchApi.getMockImplementation()
    fetchApi.mockImplementation((endpoint, options) => {
      const answer = route(endpoint, options)
      return answer === undefined ? answers?.(endpoint, options) ?? Promise.resolve({}) : Promise.resolve(answer)
    })
  }

  it('proposal: accepting a change puts it into the canvas and the page\'s draft (dirty), and marks nothing yet', async () => {
    const { onChange, review } = await acceptTheProposal(renderView)

    expect(onChange).toHaveBeenLastCalledWith(NEXT)
    expect(screen.getByTestId('fake-canvas')).toHaveTextContent('Customers wait five days for a refund.')
    expect(within(review).getByRole('status')).toHaveTextContent('Accepted changes are in your draft. Save to make them a new version.')
    expect(addressedWrites()).toStrictEqual([])
  })

  it('proposal: Discard puts the accepted change back to pending, and it can be accepted again', async () => {
    const { discarded, review, onChange } = await acceptTheProposal(renderView)
    const accept = () => within(review).getByRole('button', { name: 'Accept change 1' })

    discarded()

    expect(accept()).toBeEnabled()
    await userEvent.setup().click(accept())
    expect(onChange).toHaveBeenLastCalledWith(NEXT)
    expect(screen.getByTestId('fake-canvas')).toHaveTextContent('Customers wait five days for a refund.')
  })

  it('proposal: after the save, the accepted change\'s thread is marked addressed by the saved version', async () => {
    const { saved, review } = await acceptTheProposal(renderView)

    saved(NEXT, 3)

    await expectAddressed('doc_3', true)
    expect(await within(review).findByRole('status')).toHaveTextContent('Saved: 1 comment is marked as addressed in v3.')
    expect(within(await rail()).getByRole('button', { name: 'Ask personas to review again' })).toBeInTheDocument()
  })

  it('recommendations: nothing written; a recommendation\'s link shows its thread, focused, even a resolved one hidden by the filter', async () => {
    runAssistJob.mockResolvedValue(revised('recommendations'))

    const { onChange, user } = await startRevising(renderView)
    const panel = await screen.findByRole('region', { name: 'Recommendations from the comments' })
    const resolvedCard = () => within(screen.getByRole('complementary', { name: 'Comments' }))
      .queryAllByRole('article').find((card) => card.textContent.includes('Fixed typo'))
    expect(resolvedCard()).toBeUndefined()
    await user.click(within(panel).getByRole('button', { name: 'Show the comment: Fixed typo' }))

    await waitFor(() => expect(resolvedCard()).toHaveFocus())
    expect(screen.getByRole('checkbox', { name: 'Show resolved' })).toBeChecked()
    expect(onChange).not.toHaveBeenCalled()
  })

  it('applied: the canvas reloads on the new version; Review again asks the personas', async () => {
    runAssistJob.mockResolvedValueOnce(revised('applied', { applied_version: { document_id: 'doc_3', version: 3 }, addressed_thread_ids: ['c_quote'] }))
      .mockResolvedValueOnce({ filed: 2, personas: [{ persona_id: 'p1' }, { persona_id: 'p2' }] })

    const { canvas, user } = await startRevising(renderView)
    const banner = await screen.findByRole('region', { name: 'Revised from 1 comment as v3' })
    expect(canvas.reloadLatest).toHaveBeenCalledTimes(1)
    await user.click(within(banner).getByRole('button', { name: 'Review again' }))

    expect(await within(await rail()).findByText('2 comments filed (2 personas asked)')).toBeInTheDocument()
  })

  it('applied: Undo restores the version the pass read, then clears the pass\'s "addressed" marks on the restored version', async () => {
    runAssistJob.mockResolvedValueOnce(revised('applied', { applied_version: { document_id: 'doc_3', version: 3 }, addressed_thread_ids: ['c_quote'] }))
    answerAlso((endpoint) => {
      if (endpoint === '/projects/proj_1/documents/doc_3/versions') {
        return { versions: [{ version_id: 'doc_3', version: 3, title: 'Faster refunds', content: NEXT, current: true }] }
      }
      return endpoint.endsWith('/versions/doc_2/restore') ? { document: { ...DOCUMENT, document_id: 'doc_4', version: 4 } } : undefined
    })
    const { user } = await startRevising(renderView)
    const banner = await screen.findByRole('region', { name: 'Revised from 1 comment as v3' })

    await user.click(within(banner).getByRole('button', { name: 'Undo' }))

    await expectAddressed('doc_4', false)
    expect(await within(banner).findByRole('status')).toHaveTextContent('Undone: the previous version is restored as a new version.')
  })

  it('offers the "Addressed" filter once a thread is addressed, showing only those', async () => {
    serve({ threads: [...THREADS, thread('c_fixed', { text: 'Addressed one', status: 'resolved', addressed: { version: 2, at: '', by_kind: 'user' } })] })
    const user = userEvent.setup()
    renderView()
    await screen.findByText('Who is the customer?')

    await user.click(screen.getByRole('checkbox', { name: 'Addressed' }))

    expect(await screen.findByText('Addressed one')).toBeInTheDocument()
    expect(screen.getByText('Addressed in v2')).toBeInTheDocument()
    expect(screen.queryByText('Who is the customer?')).not.toBeInTheDocument()
  })

  describe('on the page\'s own canvas (useCanvasDocument): what its Save sends', () => {
    /** The view on a real canvas, as DocumentPage composes them, with the page's Save and Discard. */
    function CanvasPage() {
      const state = useCanvasDocument({ project: makeProject({ project_id: 'proj_1' }), document: DOCUMENT, onSelectDoc: vi.fn() })
      return (
        <>
          <DocumentReviewView projectId="proj_1" document={DOCUMENT} markdown={state.content} hasPersonas editable={state.editable}
            onChange={state.onChange} handleRef={state.handleRef} canvas={state} />
          <button type="button" onClick={() => { state.save().catch(ignoreRejection) }}>Save the page</button>
          <button type="button" onClick={state.discard}>Discard the page</button>
        </>
      )
    }
    const mountPage = () => renderWithQueryClient(<CanvasPage />)
    /** Each PUT's revise_job_id ("none": absent); no PUT ever says its own edit_kind (the server sets it). */
    const reviseJobIds = () => writes().filter(([, options]) => options?.method === 'PUT').map(([, options]) => {
      const body = sentBody(options)
      return 'edit_kind' in body ? 'edit_kind sent' : body.revise_job_id ?? 'none'
    })

    it('after an accepted change: the pass\'s job id as revise_job_id, and the thread is marked addressed by the saved version', async () => {
      const { user } = await acceptTheProposal(mountPage)

      await user.click(screen.getByRole('button', { name: 'Save the page' }))

      await waitFor(() => expect(reviseJobIds()).toStrictEqual(['job_rev_1']))
      await expectAddressed('doc_3', true)
    })

    /** A plain edit on the canvas, then the page's Save: its PUT names no pass. */
    async function savePlainEdit(user: ReturnType<typeof userEvent.setup>) {
      await user.click(await screen.findByRole('button', { name: 'Simulate an edit' }))
      await user.click(screen.getByRole('button', { name: 'Save the page' }))
      await waitFor(() => expect(reviseJobIds()).toStrictEqual(['none']))
    }

    it('after a plain edit: no revise_job_id', async () => {
      const user = userEvent.setup()
      mountPage()

      await savePlainEdit(user)

      expect(addressedWrites()).toStrictEqual([])
    })

    it('after the accepted change was discarded (then a plain edit): no revise_job_id, nothing marked', async () => {
      const { user } = await acceptTheProposal(mountPage)
      await user.click(screen.getByRole('button', { name: 'Discard the page' }))

      await savePlainEdit(user)

      expect(addressedWrites()).toStrictEqual([])
    })

    it('after the accepted change was removed by hand: no revise_job_id, nothing marked', async () => {
      const { user } = await acceptTheProposal(mountPage)

      await savePlainEdit(user)

      expect(addressedWrites()).toStrictEqual([])
    })

    it('Close keeps the accepted change: a new pass waits (with the reason), and Save still revises and marks', async () => {
      const { user, review, button } = await acceptTheProposal(mountPage)

      await user.click(within(review).getByRole('button', { name: 'Close' }))

      expect(screen.queryByRole('region', { name: 'Suggested changes' })).not.toBeInTheDocument()
      expect([button.matches(':disabled'), button.getAttribute('aria-describedby') === null]).toStrictEqual([true, false])
      expect(button).toHaveAccessibleDescription('Save or discard the accepted changes first.')
      await user.click(screen.getByRole('button', { name: 'Save the page' }))
      await waitFor(() => expect([reviseJobIds(), button.matches(':disabled')]).toStrictEqual([['job_rev_1'], false]))
      await expectAddressed('doc_3', true)
    })
  })
})

describe('the rail tabs', () => {
  it('has no tabs without evidence', async () => {
    renderView()
    await screen.findByText('Who is the customer?')

    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
  })

  it('shows "Comments | Evidence" with the comments first', async () => {
    renderView({ evidence: 'Twelve reviews about refunds' })
    await screen.findByText('Who is the customer?')

    const tabs = within(screen.getByRole('tablist', { name: 'Comments and evidence' })).getAllByRole('tab')
    expect(tabs.map((tab) => [tab.textContent, tab.getAttribute('aria-selected')])).toStrictEqual([['Comments', 'true'], ['Evidence', 'false']])
    expect(screen.getByText('Twelve reviews about refunds')).not.toBeVisible()
  })

  it('switches tabs with the arrow keys', async () => {
    const user = userEvent.setup()
    renderView({ evidence: 'Twelve reviews about refunds' })
    await screen.findByText('Who is the customer?')

    screen.getByRole('tab', { name: 'Comments' }).focus()
    await user.keyboard('{ArrowRight}')

    expect(screen.getByRole('tab', { name: 'Evidence' })).toHaveFocus()
    expect(screen.getByRole('tabpanel', { name: 'Evidence' })).toHaveTextContent('Twelve reviews about refunds')
    expect(screen.getByText('Who is the customer?')).not.toBeVisible()
  })
})

describe('when comments cannot load', () => {
  it('still shows the document, with a warning', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    renderView()

    expect(await screen.findByRole('alert')).toHaveTextContent('Comments could not be loaded.')
    expect(screen.getByText(PARAGRAPH)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bar comment' })).not.toBeInTheDocument()
  })

  it('keeps the same canvas (and its unsaved edits) when a refetch fails', async () => {
    const user = userEvent.setup()
    renderView()
    const canvas = await screen.findByTestId('fake-canvas')
    await user.click(screen.getByRole('button', { name: 'Simulate an edit' }))
    fetchApi.mockImplementation((_endpoint, options) =>
      options?.method === undefined ? Promise.reject(new Error('API Error: 500')) : Promise.resolve({ thread: thread('c_quote', {}) }))

    await user.click(within(await threadBy('sam@example.com')).getByRole('button', { name: 'Resolve' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('Comments could not be loaded.')
    expect(screen.getByTestId('fake-canvas')).toBe(canvas)
    expect(canvas).toHaveTextContent('Customers wait for a refund.')
  })
})
