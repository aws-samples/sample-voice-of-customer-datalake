/**
 * @fileoverview The Knowledge review (7.52.00): each package's newest draft opens compared with the approved version
 * (the rendered block diff), one of its seven documents at a time; **Approve** sends nothing but the version's path, and
 * a 409 says the version or the approved one moved (Read it again); a package with no approved version reads its draft
 * as agent text, never edited; the approved docs open as a pull request.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { at } from '@test/defined'
import { resetFetchApi, routeFetchApi, sentFetchApiBody } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { KnowledgeReview } = await import('./KnowledgeReview')

const BASE = '/agents/engineering/knowledge/storefront'
const version = (pkg: string, number: number, status: string) => ({ package: pkg, version: number, status, author: 'understander-1',
  author_kind: 'agent', built_from: 'a'.repeat(40), created_at: '2026-11-16T09:00:00Z' })
const OVERVIEW = { connection: 'storefront', rendering: { kind: 'knowledge', version: 1, digest: 'r' },
  packages: [{ package: '.', segment: '=2E', approved_version: 1, versions: [version('.', 1, 'approved'), version('.', 2, 'draft')] }] }
const documents = (number: number) => ({ connection: 'storefront', version: version('.', number, number === 1 ? 'approved' : 'draft'),
  documents: { architecture: `# Architecture\n\nThe API lives in src/api.\n\n${number === 2 ? 'Jobs live in src/jobs.\n' : ''}`,
    glossary: '# Glossary\n\nA *pack* is what the agents know.\n' } })

function renderReview(routes: Record<string, RouteHandler> = {}) {
  routeFetchApi({
    [`GET ${BASE}`]: () => OVERVIEW,
    [`GET ${BASE}/%3D2E/versions/1`]: () => documents(1),
    [`GET ${BASE}/%3D2E/versions/2`]: () => documents(2),
    ...routes,
  }, { missStatus: 500 })
  renderWithQueryClient(<TestRouter><KnowledgeReview connection="storefront" /></TestRouter>)
}

beforeEach(() => { resetFetchApi() })

describe('Knowledge review: a package\'s draft', () => {
  it('opens the newest draft compared with the approved version, as the document reads', async () => {
    renderReview()
    const added = await screen.findByText('Jobs live in src/jobs.')
    expect(added.closest('[data-diff]')).toHaveAttribute('data-diff', 'add')
    expect(screen.getByRole('combobox', { name: 'Version' })).toHaveValue('2')
  })

  it('reads one document at a time, as agent text, never edited', async () => {
    renderReview()
    await userEvent.click(await screen.findByRole('button', { name: 'Read' }))
    await userEvent.click(at(screen.getAllByRole('button', { name: 'Glossary' }), 0))
    expect(await screen.findByRole('heading', { level: 1, name: 'Glossary' })).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent('Changes to this are proposed, then accepted by an administrator.')
  })
})

describe('Knowledge review: Approve', () => {
  it('approves the draft, sending nothing but its path', async () => {
    renderReview({ [`POST ${BASE}/%3D2E/versions/2/approve`]: () => ({ connection: 'storefront', version: version('.', 2, 'approved') }) })
    await userEvent.click(await screen.findByRole('button', { name: 'Approve v2' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Approved v2.')
    await waitFor(() => { expect(sentFetchApiBody(`${BASE}/%3D2E/versions/2/approve`, 'POST')).toStrictEqual({}) })
  })

  it('on a 409 says the version or the approved one moved, and offers to read it again', async () => {
    renderReview({ [`POST ${BASE}/%3D2E/versions/2/approve`]: () => {
      throw new ApiError(409, 'the version or the approved one changed meanwhile: read it again')
    } })
    await userEvent.click(await screen.findByRole('button', { name: 'Approve v2' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The version or the approved one changed since you read them.')
    expect(screen.getByRole('button', { name: 'Read it again' })).toBeInTheDocument()
  })
})

describe('Knowledge review: none yet, and the pull request', () => {
  it('says there is no pack yet', async () => {
    renderReview({ [`GET ${BASE}`]: () => ({ connection: 'storefront', packages: [], rendering: null }) })
    expect(await screen.findByText(/No knowledge pack yet\./)).toBeInTheDocument()
  })

  it('opens the approved docs as a pull request', async () => {
    renderReview({ 'GET /agents/engineering/docs/storefront/preview?kind=knowledge': () => { throw new ApiError(404, 'none') } })
    await userEvent.click(await screen.findByRole('button', { name: 'Open as a pull request' }))
    expect(await screen.findByRole('dialog', { name: 'Open the knowledge docs as a pull request' })).toBeInTheDocument()
  })
})
