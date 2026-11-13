/**
 * The draft banner on a prototype's pane (docs/prototype-builder.md, part 2): editors only, for the
 * open prototype's series only, the summary as text, Draft / Current in the frame (the draft without
 * popups and without the pin bridge), Apply (201 selects the new version; a 409 says the series moved and
 * keeps Discard) and Discard (the job delete).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { PrototypeWithDraft } from './PrototypeDraftBanner'
import PrototypePinsReview from '../../components/PrototypePins/PrototypePinsReview'
import { draftCandidates, shownDraft } from './prototypeDraft'
import type { ProjectDocument } from '../../api/types'
import type { ProjectJob } from '../../api/projectTypes'
import type { PrototypeDraft } from '../../api/prototypeDraftSchema'
import { ApiError } from '../../lib/errors'

const api = vi.hoisted(() => ({
  getJobs: vi.fn<(projectId: string) => Promise<{ success: boolean; jobs: ProjectJob[] }>>(),
  getPrototypeDraft: vi.fn<(projectId: string, documentId: string, draftId: string) => Promise<PrototypeDraft | null>>(),
  applyPrototypeDraft: vi.fn<(projectId: string, documentId: string, draftId: string) => Promise<ProjectDocument | null>>(),
  dismissJob: vi.fn<(projectId: string, jobId: string) => Promise<{ success: boolean }>>(),
}))
vi.mock('../../api/projectsApi', () => ({ projectsApi: api }))
const submitPrototypePin = vi.hoisted(() => vi.fn<(formId: string, body: unknown) => Promise<unknown>>())
vi.mock('../../api/client', () => ({ api: { submitPrototypePin }, fetchApi: vi.fn() }))

const prototype = (n: number, extra: Partial<ProjectDocument> = {}): ProjectDocument => ({
  document_id: `proto_${String(n)}`, document_type: 'prototype', title: `Checkout (v${String(n)})`,
  base_title: 'Checkout', version: n, content: '', created_at: `2026-05-0${String(n)}T10:00:00Z`,
  prototype_url: `https://cdn.example.com/prototypes/p1/proto_${String(n)}.html`, ...extra,
})
const v1 = prototype(1)
const v2 = prototype(2)
const otherSeries = prototype(9, { document_id: 'other_9', title: 'Onboarding (v9)', base_title: 'Onboarding' })

const job = (id: string, completedAt: string, extra: Partial<ProjectJob> = {}): ProjectJob => ({
  job_id: id, job_type: 'draft_prototype', status: 'completed', progress: 100, created_at: completedAt,
  completed_at: completedAt, ...extra,
})
const draft = (extra: Partial<PrototypeDraft> = {}): PrototypeDraft => ({
  draft_id: 'job_1', base_document_id: 'proto_2', base_version: 2, instruction: 'make the footer sticky on phones',
  summary: 'Checkout: the footer sticks on phones\nCart: <b>unchanged</b> **really**',
  preview_url: 'https://cdn.example.com/prototypes/p1/drafts/job_1.html', ...extra,
})

const SUBMIT = {
  source: 'voc-pin-widget', type: 'submit', formId: 'pf_0123456789abcdef', requestId: 'r1',
  body: { text: 'This button does nothing', pin: { route: '/' } },
}

function renderPane({ document = v2, documents = [v1, v2, otherSeries], canEdit = true } = {}) {
  const onSelectDoc = vi.fn()
  renderWithQueryClient(
    <PrototypeWithDraft projectId="p1" document={document} documents={documents} canEdit={canEdit} onSelectDoc={onSelectDoc}>
      <PrototypePinsReview projectId="p1" documentId={document.document_id} url={document.prototype_url}
        title={document.title} canEdit={canEdit} />
    </PrototypeWithDraft>,
  )
  return { user: userEvent.setup(), onSelectDoc }
}

const banner = () => screen.findByRole('region', { name: 'Draft ready: applied to a preview, not saved' })

/** Renders the pane, makes Apply reject with `error` and presses it: the banner and the selection spy. */
async function applyFailingWith(error: Error) {
  api.applyPrototypeDraft.mockRejectedValue(error)
  const { user, onSelectDoc } = renderPane()
  const region = await banner()
  await user.click(within(region).getByRole('button', { name: 'Apply as v3' }))
  return { region, onSelectDoc }
}

describe('draftCandidates and shownDraft', () => {
  it('reads the newest finished draft jobs only, newest first', () => {
    const jobs = [
      job('old', '2026-11-10T10:00:00Z'), job('new', '2026-11-13T10:00:00Z'), job('mid', '2026-11-12T10:00:00Z'),
      job('running', '2026-11-13T11:00:00Z', { status: 'running' }),
      job('build', '2026-11-13T12:00:00Z', { job_type: 'build_prototype' }),
    ]
    expect(draftCandidates(jobs)).toStrictEqual(['new', 'mid', 'old'])
  })

  it('reads at most the ten newest (the window is the whole project\'s)', () => {
    const jobs = Array.from({ length: 12 }, (_, i) => job(`d${String(i)}`, `2026-11-${String(10 + i).padStart(2, '0')}T10:00:00Z`))
    expect(draftCandidates(jobs)).toStrictEqual(['d11', 'd10', 'd9', 'd8', 'd7', 'd6', 'd5', 'd4', 'd3', 'd2'])
  })

  it('shows the newest draft of the series, fresh on the newest version and stale once the series moved', () => {
    const series = [v2, v1]
    expect(shownDraft([null, draft({ base_document_id: 'other_9' }), draft()], series)).toStrictEqual({ draft: draft(), state: 'fresh' })
    expect(shownDraft([draft({ base_document_id: 'proto_1', base_version: 1 })], series)?.state).toBe('stale')
    expect(shownDraft([draft({ base_document_id: 'other_9' })], series)).toBeNull()
  })

  it('shows no draft once a version of the series records it (applied)', () => {
    const v3 = prototype(3, { revised_from_id: 'proto_2', revision_feedback: 'make the footer sticky on phones' })
    expect(shownDraft([draft()], [v3, v2, v1])).toBeNull()
  })
})

describe('PrototypeWithDraft', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.getJobs.mockResolvedValue({ success: true, jobs: [job('job_1', '2026-11-13T10:00:00Z')] })
    api.getPrototypeDraft.mockResolvedValue(draft())
    api.dismissJob.mockResolvedValue({ success: true })
  })

  it('shows the instruction and the summary as plain text lines (never Markdown or HTML)', async () => {
    renderPane()
    const region = await banner()

    expect(within(region).getByText('make the footer sticky on phones')).toBeInTheDocument()
    const items = within(region).getAllByRole('listitem').map((item) => item.textContent)
    expect(items).toStrictEqual(['Checkout: the footer sticks on phones', 'Cart: <b>unchanged</b> **really**'])
    expect(region.querySelector('b, strong')).toBeNull()
  })

  it("opens on the draft: its own URL in a frame without popups, read through the open version's route", async () => {
    renderPane()
    const region = await banner()

    expect(within(region).getByRole('button', { name: 'Draft' })).toHaveAttribute('aria-pressed', 'true')
    const frame = screen.getByTitle('Checkout (v2) (draft)')
    expect([frame.getAttribute('src'), frame.getAttribute('sandbox')])
      .toStrictEqual(['https://cdn.example.com/prototypes/p1/drafts/job_1.html', 'allow-scripts'])
    expect(api.getPrototypeDraft).toHaveBeenCalledWith('p1', 'proto_2', 'job_1')
  })

  it('switches the preview between the draft and the current version', async () => {
    const { user } = renderPane()
    const region = await banner()

    await user.click(within(region).getByRole('button', { name: 'Current' }))

    expect(within(region).getByRole('button', { name: 'Current' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.queryByTitle('Checkout (v2) (draft)')).toBeNull()
    expect(screen.getByTitle('Checkout (v2)')).toHaveAttribute('sandbox', 'allow-scripts allow-popups')

    await user.click(within(region).getByRole('button', { name: 'Draft' }))
    expect(screen.getByTitle('Checkout (v2) (draft)')).toBeInTheDocument()
  })

  it("drops a pin posted by the draft's frame (no pin bridge), while the current version's still reaches the form", async () => {
    submitPrototypePin.mockResolvedValue({ success: true })
    const { user } = renderPane()
    await banner()
    const post = (frame: HTMLIFrameElement) => {
      fireEvent(window, new MessageEvent('message', { data: SUBMIT, origin: 'null', source: frame.contentWindow }))
    }

    post(screen.getByTitle<HTMLIFrameElement>('Checkout (v2) (draft)'))
    expect(submitPrototypePin).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Current' }))
    post(screen.getByTitle<HTMLIFrameElement>('Checkout (v2)'))
    expect(submitPrototypePin).toHaveBeenCalledTimes(1)
  })

  it('applies the draft as the next version and selects it', async () => {
    const v3 = prototype(3)
    api.applyPrototypeDraft.mockResolvedValue(v3)
    const { user, onSelectDoc } = renderPane()
    const region = await banner()

    await user.click(within(region).getByRole('button', { name: 'Apply as v3' }))

    expect(api.applyPrototypeDraft).toHaveBeenCalledWith('p1', 'proto_2', 'job_1')
    await vi.waitFor(() => { expect(onSelectDoc).toHaveBeenCalledWith(v3) })
  })

  it('on a 409 says the prototype changed, drops Apply and keeps Discard', async () => {
    const { region, onSelectDoc } = await applyFailingWith(new ApiError(409, 'The document was changed by someone else; reload it and try again'))

    expect(await within(region).findByRole('status')).toHaveTextContent(
      'The prototype changed since this draft: ask again on the newest version')
    expect({
      apply: within(region).queryByRole('button', { name: 'Apply as v3' }),
      discardDisabled: within(region).getByRole('button', { name: 'Discard' }).hasAttribute('disabled'),
      alert: within(region).queryByRole('alert'),
      selected: onSelectDoc.mock.calls.length,
    }).toStrictEqual({ apply: null, discardDisabled: false, alert: null, selected: 0 })
  })

  const APPLY_RETRY = "The draft couldn't be applied. Try again."

  // A refusal the server explains is shown in its words; anything trying again can fix keeps "try again".
  it.each([
    ['a 400 with its reason', new ApiError(400, 'This prototype is an early screen spec'), 'This prototype is an early screen spec'],
    ['a 404 with its reason', new ApiError(404, 'Draft not found'), 'Draft not found'],
    ['a 404 without one', new ApiError(404), APPLY_RETRY],
    ['a server failure', new ApiError(500, 'Internal error'), APPLY_RETRY],
    ['a throttled request', new ApiError(429, 'Too many requests'), APPLY_RETRY],
  ])('on %s Apply says so in an alert', async (_case, error, text) => {
    const { region } = await applyFailingWith(error)

    expect(await within(region).findByRole('alert')).toHaveTextContent(text)
  })

  it('a Discard that fails says to try again and keeps the banner', async () => {
    api.dismissJob.mockRejectedValue(new ApiError(500, 'Internal error'))
    const { user } = renderPane()
    const region = await banner()

    await user.click(within(region).getByRole('button', { name: 'Discard' }))

    expect(await within(region).findByRole('alert')).toHaveTextContent("The draft couldn't be discarded. Try again.")
  })

  it('after a 409 on one draft and its Discard, the next draft opens fresh (no state carried over)', async () => {
    api.getJobs.mockResolvedValue({ success: true, jobs: [job('job_1', '2026-11-13T10:00:00Z'), job('job_2', '2026-11-12T10:00:00Z')] })
    // Once discarded, draft A's GET is a 404 (null), as the server answers it.
    const discarded = new Set<string>()
    api.dismissJob.mockImplementation((_project, jobId) => { discarded.add(jobId); return Promise.resolve({ success: true }) })
    api.getPrototypeDraft.mockImplementation((_project, _document, draftId) => {
      if (discarded.has(draftId)) return Promise.resolve(null)
      return Promise.resolve(draftId === 'job_1' ? draft() : draft({ draft_id: 'job_2', instruction: 'drop the footer' }))
    })
    const { region } = await applyFailingWith(new ApiError(409, 'The document was changed by someone else; reload it and try again'))
    await within(region).findByRole('status')

    await userEvent.setup().click(within(region).getByRole('button', { name: 'Discard' }))

    const next = await banner()
    await vi.waitFor(() => { expect(next).toHaveTextContent('Instruction: drop the footer') })
    expect(within(next).getByRole('button', { name: 'Apply as v3' })).toBeEnabled()
    expect(within(next).queryByRole('status')).toBeNull()
  })

  it('a stale draft (the series moved past its base) offers only Discard', async () => {
    api.getPrototypeDraft.mockResolvedValue(draft({ base_document_id: 'proto_1', base_version: 1 }))
    renderPane()
    const region = await banner()

    expect(within(region).getByRole('status')).toHaveTextContent('The prototype changed since this draft')
    expect(within(region).queryByRole('button', { name: /Apply as/ })).toBeNull()
    expect(within(region).getByRole('button', { name: 'Discard' })).toBeInTheDocument()
  })

  it('discards through the job delete, and the banner goes', async () => {
    const { user } = renderPane()
    const region = await banner()
    api.getJobs.mockResolvedValue({ success: true, jobs: [] })

    await user.click(within(region).getByRole('button', { name: 'Discard' }))

    expect(api.dismissJob).toHaveBeenCalledWith('p1', 'job_1')
    await vi.waitFor(() => { expect(screen.queryByTestId('prototype-draft-banner')).toBeNull() })
    expect(screen.getByTitle('Checkout (v2)')).toBeInTheDocument()
  })

  it('shows no draft of another series', async () => {
    api.getPrototypeDraft.mockResolvedValue(draft({ base_document_id: 'other_9', base_version: 9 }))
    renderPane()

    await vi.waitFor(() => { expect(api.getPrototypeDraft).toHaveBeenCalledWith('p1', 'proto_2', 'job_1') })
    expect(screen.queryByTestId('prototype-draft-banner')).toBeNull()
    expect(screen.getByTitle('Checkout (v2)')).toBeInTheDocument()
  })

  it('reads nothing for a viewer and shows no banner', () => {
    renderPane({ canEdit: false })

    expect(api.getJobs).not.toHaveBeenCalled()
    expect(api.getPrototypeDraft).not.toHaveBeenCalled()
    expect(screen.queryByTestId('prototype-draft-banner')).toBeNull()
  })
})
