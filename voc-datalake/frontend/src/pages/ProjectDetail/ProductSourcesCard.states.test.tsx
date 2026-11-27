/**
 * The Sources card's states (7.104.00, docs/project-workspace.md → Product tab): empty, uploading, read (pending,
 * extracting, a link fetching), ready (the characters, the pages, "cut" when truncated, a link's title and host),
 * failed (the reason in its own red; Retry for a PDF, DOCX or PPTX only, the files the server reads again), a refused
 * Retry or Fetch again in the server's words, a Retry under way (off until its answer), Delete's 24 px target, a list
 * that could not be read (Try again, never the empty state), the injection note, Add link (https only, the server's
 * refusal said) and the viewer, who reads the list and gets nothing that writes. The polling's windows are pinned on
 * their own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { defined } from '@test/defined'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { DOCS_PATH, PROJECT, extractStub, sourceDoc } from './product-sources-fixtures'
import ProductSourcesCard from './ProductSourcesCard'
import { sourcesPollInterval } from './useProductSources'
import type { ProductDoc } from '../../api/projectTypes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

/** A PDF whose read failed: the one kind of file the server reads again on Retry (`POST …/refresh`). */
const FAILED_PDF = sourceDoc({
  filename: 'scan.pdf', content_type: 'application/pdf', status: 'failed', error: 'The file could not be read: it is password protected.',
})

function renderCard(docs: ProductDoc[], { canEdit = true, onAnswerQuestions = vi.fn() } = {}) {
  routeFetchApi({ [`GET ${DOCS_PATH}`]: () => ({ docs }) })
  renderWithQueryClient(<ProductSourcesCard projectId={PROJECT} canEdit={canEdit} extract={extractStub()} onAnswerQuestions={onAnswerQuestions} />)
}

/** The card with no source and `urls` answering POST …/urls; the link field. */
async function renderWithLink(urls: RouteHandler): Promise<HTMLElement> {
  routeFetchApi({ [`GET ${DOCS_PATH}`]: () => ({ docs: [] }), [`POST ${DOCS_PATH}/urls`]: urls })
  renderWithQueryClient(<ProductSourcesCard projectId={PROJECT} canEdit extract={extractStub()} onAnswerQuestions={vi.fn()} />)
  return screen.findByLabelText('Add a link')
}

beforeEach(() => {
  resetFetchApi()
})

describe('ProductSourcesCard states', () => {
  it('is empty with a way to answer questions instead', async () => {
    const onAnswerQuestions = vi.fn()
    const user = userEvent.setup()
    renderCard([], { onAnswerQuestions })
    expect(await screen.findByText('Add documents, images or links, or answer a few questions.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Answer questions' }))
    expect(onAnswerQuestions).toHaveBeenCalledTimes(1)
  })

  it('shows each kind with its own status while it is read', async () => {
    renderCard([
      sourceDoc({ doc_id: 'a', filename: 'deck.pptx', status: 'pending' }),
      sourceDoc({ doc_id: 'b', filename: 'plan.pdf', status: 'extracting' }),
      sourceDoc({ doc_id: 'c', source_kind: 'url', url: 'https://example.com/p', filename: 'https://example.com/p', status: 'extracting' }),
    ])
    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toStrictEqual([
      expect.stringMatching(/^deck\.pptx\s*Waiting to be read/),
      expect.stringMatching(/^plan\.pdf\s*Reading…/),
      expect.stringMatching(/^example\.com\s*Fetching…/),
    ])
  })

  it('says what a ready source\'s reading found: characters, pages, read by AI, and "cut" when truncated', async () => {
    renderCard([
      sourceDoc({ filename: 'pricing.pdf', content_type: 'application/pdf', size_bytes: 0, extracted_chars: 40_000, pages: 12, method: 'model', truncated: true }),
      sourceDoc({ doc_id: 'l', source_kind: 'url', url: 'https://example.com/p', final_url: 'https://www.example.com/p', title: 'Sample page', extracted_chars: 4200 }),
      sourceDoc({ doc_id: 'i', source_kind: 'interview', interview_mode: 'voice', filename: 'answers-voice.md', extracted_chars: 300 }),
    ])
    await screen.findByText('pricing.pdf')
    const [pdf, link, voice] = screen.getAllByRole('listitem')
    expect(pdf).toHaveTextContent('pricing.pdf Ready40,000 characters read · 12 pages · read by AI · cut at the reading limit')
    expect(screen.getByText('cut at the reading limit')).toHaveClass('text-warn')
    expect(link).toHaveTextContent('Sample page Readywww.example.com · 4,200 characters read')
    expect(voice).toHaveTextContent('Voice interview Ready300 characters read')
  })

  it('shows a failed PDF\'s reason in red, and retries it', async () => {
    const user = userEvent.setup()
    renderCard([FAILED_PDF])
    routeFetchApi({
      [`GET ${DOCS_PATH}`]: () => ({ docs: [] }),
      [`POST ${DOCS_PATH}/doc-1/refresh`]: () => ({ doc: { ...FAILED_PDF, status: 'extracting', error: null } }),
    })
    const reason = await screen.findByText('The file could not be read: it is password protected.', { ignore: '[role="tooltip"]' })
    expect(reason).toHaveClass('text-danger')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith(`${DOCS_PATH}/doc-1/refresh`, expect.objectContaining({ method: 'POST' })))
  })

  it.each([
    ['a Markdown file', sourceDoc({ status: 'failed', error: 'Text extraction did not complete.' })],
    ['an image', sourceDoc({ filename: 'shot.png', content_type: 'image/png', status: 'failed', error: 'Text extraction did not complete.' })],
  ])('offers no Retry on %s whose read failed (the server reads it once), only Delete', async (_kind, doc) => {
    renderCard([doc])
    await screen.findByText('Text extraction did not complete.', { ignore: '[role="tooltip"]' })
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Delete source' })).toBeInTheDocument()
  })

  it('says a refused Retry or Fetch again in the server\'s words, and clears it at the next action', async () => {
    const user = userEvent.setup()
    const link = sourceDoc({ doc_id: 'l', source_kind: 'url', url: 'https://example.com/p', filename: 'https://example.com/p' })
    routeFetchApi({
      [`GET ${DOCS_PATH}`]: () => ({ docs: [FAILED_PDF, link] }),
      [`POST ${DOCS_PATH}/l/refresh`]: () => { throw new ApiError(429, 'A project reads at most 30 links a day. Try again tomorrow.', 'rate_limited') },
      [`POST ${DOCS_PATH}/doc-1/refresh`]: () => { throw new ApiError(409, 'This source is being read. Wait for it to finish.', 'extracting') },
      [`DELETE ${DOCS_PATH}/doc-1`]: () => ({ success: true }),
    })
    renderWithQueryClient(<ProductSourcesCard projectId={PROJECT} canEdit extract={extractStub()} onAnswerQuestions={vi.fn()} />)
    await user.click(await screen.findByRole('button', { name: 'Fetch again' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The source was not read again: A project reads at most 30 links a day. Try again tomorrow.')
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The source was not read again: This source is being read. Wait for it to finish.'))
    await user.click(defined(screen.getAllByRole('button', { name: 'Delete source' })[0], 'the PDF\'s Delete'))
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
  })

  it('waits for a Retry under way: the button is off until its answer, so a second click sends nothing', async () => {
    // Review Q7 (7.104.00 round 2): Retry and Fetch again stayed on while their request was pending.
    const user = userEvent.setup()
    const pending = { answer: (_doc: { doc: ProductDoc }) => {} }
    routeFetchApi({
      [`GET ${DOCS_PATH}`]: () => ({ docs: [FAILED_PDF] }),
      [`POST ${DOCS_PATH}/doc-1/refresh`]: () => new Promise((resolve) => { pending.answer = resolve }),
    })
    renderWithQueryClient(<ProductSourcesCard projectId={PROJECT} canEdit extract={extractStub()} onAnswerQuestions={vi.fn()} />)
    const retry = await screen.findByRole('button', { name: 'Retry' })
    await user.click(retry)
    await waitFor(() => expect(retry).toBeDisabled())
    await user.click(retry)
    expect(fetchApi.mock.calls.filter(([path]) => path === `${DOCS_PATH}/doc-1/refresh`)).toHaveLength(1)
    pending.answer({ doc: { ...FAILED_PDF, status: 'extracting', error: null } })
    await waitFor(() => expect(retry).toBeEnabled())
  })

  it('gives Delete a target of at least 24 x 24 px', async () => {
    // Review Q8 (7.104.00 round 2): the 14 px icon was the whole target.
    renderCard([sourceDoc()])
    expect(await screen.findByRole('button', { name: 'Delete source' })).toHaveClass('min-h-6', 'min-w-6')
  })

  it('says a list it could not read, with Try again, never the empty state', async () => {
    // Review Q6 (7.104.00 round 2): a failed read of the sources read as "Add documents, images or links".
    const user = userEvent.setup()
    const list = vi.fn<() => unknown>(() => { throw new ApiError(500, 'Internal server error') })
    routeFetchApi({ [`GET ${DOCS_PATH}`]: () => list() })
    renderWithQueryClient(<ProductSourcesCard projectId={PROJECT} canEdit extract={extractStub()} onAnswerQuestions={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('The sources could not be loaded.')
    expect(screen.queryByText('Add documents, images or links, or answer a few questions.')).not.toBeInTheDocument()
    list.mockReturnValue({ docs: [sourceDoc()] })
    await user.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByText('brief.md')).toBeInTheDocument()
    expect(screen.queryByText(/could not be loaded/)).not.toBeInTheDocument()
  })

  it('notes a source whose text reads like instructions to a model: read as data only', async () => {
    renderCard([sourceDoc({ injection_flag: true })])
    expect(await screen.findByText(/read as data only, never followed/)).toBeInTheDocument()
  })

  it('adds an https link, and refuses anything else before the request', async () => {
    const user = userEvent.setup()
    const field = await renderWithLink(() => ({ doc: sourceDoc({ source_kind: 'url', status: 'extracting' }) }))
    await user.type(field, 'http://example.com/p')
    await user.click(screen.getByRole('button', { name: 'Add link' }))
    expect(screen.getByRole('alert')).toHaveTextContent('starts with https://')
    await user.clear(field)
    await user.type(field, 'https://example.com/p')
    await user.click(screen.getByRole('button', { name: 'Add link' }))
    await waitFor(() => expect(sentFetchApiBody(`${DOCS_PATH}/urls`, 'POST')).toStrictEqual({ url: 'https://example.com/p' }))
    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('says the server\'s refusal of a link in its own words', async () => {
    const user = userEvent.setup()
    const field = await renderWithLink(() => { throw new ApiError(400, 'The page is not public', 'not_public') })
    await user.type(field, 'https://intranet.example/p')
    await user.click(screen.getByRole('button', { name: 'Add link' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The link was not added: The page is not public')
  })

  it('for a viewer, lists the sources with no drop zone, link, Delete, Retry or Extract', async () => {
    renderCard([sourceDoc(), sourceDoc({ doc_id: 'f', filename: 'scan.pdf', status: 'failed', error: 'x' })], { canEdit: false })
    expect(await screen.findByText('brief.md')).toBeInTheDocument()
    for (const name of [/drop files here/i, /delete/i, /retry/i, /extract/i, /add link/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(screen.queryByLabelText('Add a link')).not.toBeInTheDocument()
  })
})

describe('sourcesPollInterval', () => {
  const reading = [sourceDoc({ status: 'extracting' })]
  it.each([
    ['nothing read', [sourceDoc()], 0, 0],
    ['the first minute', reading, 59_000, 3000],
    ['after a minute', reading, 61_000, 15_000],
    ['just under 16 minutes', reading, 16 * 60_000 - 1, 15_000],
    ['16 minutes', reading, 16 * 60_000, 0],
  ])('polls %s at %d ms', (_label, docs, elapsed, expected) => {
    expect(sourcesPollInterval(docs, 1_000_000, 1_000_000 + elapsed)).toBe(expected)
  })

  it('does not poll before a reading window began', () => {
    expect(sourcesPollInterval(reading, null, 5)).toBe(0)
  })
})
