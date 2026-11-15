/**
 * @fileoverview The run monitor's reactions on the host (7.10.00): the latest read's facts, each body as plain text
 * (never HTML), and the hand trigger behind its confirmation, only on an ended run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { ReactionsSchema } from '../../api/engineeringReactionsApi'
import type { RunReactions } from '../../api/engineeringReactionsApi'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { EngineeringRunReactions } = await import('./EngineeringRunReactions')

const RUN = '01JDA7K3M9Q2R5T8V0W4X6Y1Z3'
const ASK = `POST /agents/engineering/${RUN}/reactions`

function reactions(fields: Record<string, unknown> = {}): RunReactions {
  const parsed = ReactionsSchema.parse({
    schema: 'voc-reactions/1', pull_request: { host: 'github', number: 7, url: 'https://github.com/example-org/storefront/pull/7' },
    state: 'merged', merged_at: '2026-11-12T10:00:00Z', merge_commit: 'a'.repeat(40),
    items: [
      { kind: 'review', state: 'changes_requested', author: 'robin-maintainer', at: '2026-11-12T09:05:00Z', body: 'Keep <b>x</b> as it was.' },
      { kind: 'comment', state: '', author: 'sam-collaborator', at: '2026-11-11T16:00:00Z', body: 'Thanks.' },
    ],
    dropped: { outsiders: 2, bots: 1 }, reverted: true, revert_commit: 'b'.repeat(40),
    edits_after_merge: { people_commits: 3, files: ['src/sort.ts', 'src/page.ts'], paths_read: 2, paths_total: 2 },
    more: false, read_at: '2026-11-13T10:00:00.000000Z', asked_by: 'schedule',
    counts: { approved: 0, changes_requested: 1, commented: 0, review_comments: 0, comments: 1 },
    reviewers: [{ reviewer: 'robin-maintainer', state: 'changes_requested', at: '2026-11-12T09:05:00Z' }],
    ...fields,
  })
  if (parsed === null) throw new Error('the fixture is not a read')
  return parsed
}

function renderPanel(found: RunReactions | null, status = 'done', isAdmin = true) {
  renderWithQueryClient(<EngineeringRunReactions runId={RUN} status={status} reactions={found} isAdmin={isAdmin} />)
}

beforeEach(() => { resetFetchApi() })

describe('the run monitor\'s reactions on the host', () => {
  it('says when nothing has been read yet', () => {
    renderPanel(null, 'done', false)
    expect(screen.getByText(/No reactions read yet/)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })

  it('shows a body as literal text, never as HTML', () => {
    renderPanel(reactions())
    const items = screen.getByRole('list', { name: 'Reactions, newest first' })
    expect(within(items).getByText('Keep <b>x</b> as it was.')).toBeInTheDocument()
    expect(items.querySelector('b')).toBeNull()
  })

  it('shows the revert, the edits after the merge, what was left out and who asked', () => {
    renderPanel(reactions())
    expect(screen.getByText(`Reverted after the merge, by commit ${'b'.repeat(40)}`)).toBeInTheDocument()
    expect(screen.getByText(/3 commits changed its files within 14 days: src\/sort.ts, src\/page.ts/)).toBeInTheDocument()
    expect(screen.getByText('Left out: 2 from people without write access, 1 from bots.')).toBeInTheDocument()
    expect(screen.getByText(/by the schedule/)).toBeInTheDocument()
  })

  it('lists each reviewer\'s latest state', () => {
    renderPanel(reactions())
    const reviewers = screen.getByRole('list', { name: 'Each reviewer\'s latest review' })
    expect(reviewers).toHaveTextContent('robin-maintainer: Changes requested')
  })
})

describe('reading the reactions by hand', () => {
  it('keeps the button off, saying why, while the run is under way', () => {
    renderPanel(null, 'active')
    const button = screen.getByRole('button', { name: 'Read reactions now' })
    expect(button).toBeDisabled()
    expect(button).toHaveAccessibleDescription('Available once the run has ended.')
  })

  it('asks for a read after the confirmation, and says it was asked for', async () => {
    routeFetchApi({ [ASK]: () => ({ reactions: { status: 'asked' } }) }, { missStatus: 500 })
    renderPanel(reactions())
    await userEvent.click(screen.getByRole('button', { name: 'Read reactions now' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Read now' }))
    expect(await screen.findByText(/Asked for: the reactions show here/)).toBeInTheDocument()
    expect(fetchApi).toHaveBeenCalledWith(`/agents/engineering/${RUN}/reactions`, expect.objectContaining({ method: 'POST' }))
  })

  it('sends nothing when the confirmation is cancelled', async () => {
    routeFetchApi({}, { missStatus: 500 })
    renderPanel(reactions())
    await userEvent.click(screen.getByRole('button', { name: 'Read reactions now' }))
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(fetchApi).not.toHaveBeenCalled()
  })

  it('says to ask again later when this hour\'s read was asked for already', async () => {
    routeFetchApi({ [ASK]: () => { throw new ApiError(429, 'asked in this hour already') } }, { missStatus: 500 })
    renderPanel(reactions())
    await userEvent.click(screen.getByRole('button', { name: 'Read reactions now' }))
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Read now' }))
    expect(await screen.findByText(/already asked for in this hour/)).toBeInTheDocument()
  })
})
