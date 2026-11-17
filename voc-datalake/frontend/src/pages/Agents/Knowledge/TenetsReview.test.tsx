/**
 * @fileoverview The Tenets review (7.52.00; D6-3, gap P): the newest draft opens first, read as agent text with what
 * it changes from the version it was drafted on (keyed by tenet id); it is accepted (the one primary) or rejected
 * with a reason, never edited, each decision naming the accepted version the screen showed; a 409 says the accepted
 * tenets moved and **Read it again** reads them, the next decision naming the new one; an accepted version opens as a
 * pull request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { defined } from '@test/defined'
import { resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { TenetsReview } = await import('./TenetsReview')

const BASE = '/agents/engineering/tenets/storefront'
const tenet = (id: string, title: string, statement: string) => ({ id, title, statement, rationale: '', citations: ['src/api.py:12'] })
const V1 = { summary: 'What we value.', tenets: [tenet('api-compat', 'Keep the API', 'Never break it.'), tenet('tabs', 'Use tabs', 'Tabs.')] }
const V2 = { summary: 'Read again.', tenets: [tenet('api-compat', 'Keep the API', 'Never break it, nor its codes.'),
  tenet('tests', 'Every fix comes with a test', 'A fix lands with a test.')] }
const version = (number: number, status: string, record: unknown, base = 0) => ({
  version: number, status, current: false, record, ids: [], author: 'understander-1', author_kind: 'agent', run_id: null,
  base_version: base, created_at: '2026-11-16T09:00:00Z', decided_by: null, decided_at: null, reason: null,
})
const head = (accepted: number) => ({ versions: 2, accepted_version: accepted, accepted_ids: [], accepted_by: 'admin', accepted_at: null })
const overview = (accepted = 1) => ({ connection: 'storefront', head: head(accepted),
  versions: [version(2, 'draft', V2, 1), version(1, 'accepted', V1)] })

function routes(extra: Record<string, RouteHandler> = {}) {
  routeFetchApi({
    [`GET ${BASE}`]: () => overview(),
    [`GET ${BASE}/versions/2`]: () => ({ connection: 'storefront', version: version(2, 'draft', V2, 1), log: [] }),
    [`GET ${BASE}/versions/1`]: () => ({ connection: 'storefront', version: version(1, 'accepted', V1), log: [] }),
    ...extra,
  }, { missStatus: 500 })
  renderWithQueryClient(<TestRouter><TenetsReview connection="storefront" /></TestRouter>)
}

beforeEach(() => { resetFetchApi() })

describe('Tenets review: a draft', () => {
  it('opens the newest draft, with what it changes from the version it was drafted on, by tenet id', async () => {
    routes()
    const changes = await screen.findByRole('region', { name: 'Changes' })
    expect(within(changes).getAllByRole('listitem').map((item) => item.textContent)).toStrictEqual([
      'ChangedKeep the APIapi-compatits statement', 'AddedEvery fix comes with a testtests', 'RemovedUse tabstabs'])
    expect(screen.getByText('Compared with v1.')).toBeInTheDocument()
  })

  it('reads as agent text, what it cites as code, and is never edited', async () => {
    routes()
    expect(await screen.findByRole('heading', { name: 'Every fix comes with a test (tests)' })).toBeInTheDocument()
    expect(screen.getAllByText('src/api.py:12')[0]?.tagName).toBe('CODE')
    expect(screen.getByRole('note')).toHaveTextContent('Changes to this are proposed, then accepted by an administrator.')
    expect(screen.queryByRole('textbox', { name: /Tenets/ })).toBeNull()
  })
})

describe('Tenets review: the decision (gap P)', () => {
  it('accepts it from the accepted version the screen showed', async () => {
    routes({ [`POST ${BASE}/versions/2/accept`]: () => ({ connection: 'storefront', version: version(2, 'accepted', V2, 1), log: [] }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Accept v2' }))
    await waitFor(() => { expect(sentFetchApiBody(`${BASE}/versions/2/accept`, 'POST')).toStrictEqual({ expected_accepted: 1 }) })
  })

  it('rejects it with its reason', async () => {
    routes({ [`POST ${BASE}/versions/2/reject`]: () => ({ connection: 'storefront', version: version(2, 'rejected', V2, 1), log: [] }) })
    await userEvent.type(await screen.findByLabelText('Reason (optional)'), 'Too vague: run Tenets again.')
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }))
    await waitFor(() => {
      expect(sentFetchApiBody(`${BASE}/versions/2/reject`, 'POST')).toStrictEqual({ expected_accepted: 1, reason: 'Too vague: run Tenets again.' })
    })
  })

  it('on a 409 says the accepted tenets moved, reads them again, and the next decision names the new one', async () => {
    const state = { accepted: 1 }
    const sent: unknown[] = []
    const answers = [
      () => { throw new ApiError(409, 'the accepted version was 1 and is 3 now: read it again') },
      () => ({ connection: 'storefront', version: version(2, 'accepted', V2, 1), log: [] }),
    ]
    routes({
      [`GET ${BASE}`]: () => overview(state.accepted),
      [`POST ${BASE}/versions/2/accept`]: (body) => { sent.push(body); return defined(answers.shift(), 'an answer')() },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Accept v2' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The accepted tenets changed since you read them.')
    state.accepted = 3
    await userEvent.click(screen.getByRole('button', { name: 'Read it again' }))
    await waitFor(() => { expect(screen.queryByRole('alert')).toBeNull() })
    await userEvent.click(screen.getByRole('button', { name: 'Accept v2' }))
    await waitFor(() => { expect(sent).toStrictEqual([{ expected_accepted: 1 }, { expected_accepted: 3 }]) })
  })
})

describe('Tenets review: none yet, and the pull request', () => {
  it('says none is drafted yet', async () => {
    routes({ [`GET ${BASE}`]: () => ({ connection: 'storefront', head: { versions: 0, accepted_version: null }, versions: [] }) })
    expect(await screen.findByText(/No tenets drafted yet\./)).toBeInTheDocument()
  })

  it('opens an accepted version as a pull request', async () => {
    routes({ 'GET /agents/engineering/docs/storefront/preview?kind=tenets': () => { throw new ApiError(404, 'no tenets docs are approved') } })
    await userEvent.click(await screen.findByRole('button', { name: 'Open as a pull request' }))
    expect(await screen.findByRole('dialog', { name: 'Open TENETS.md as a pull request' })).toBeInTheDocument()
  })
})
