/**
 * Bulk admin approval cards (import_reviews, create_users, set_source_enabled):
 * every cell is rendered deterministically from the args, and approval runs the
 * existing admin-only REST writes — json-upload with derived de-duplication
 * ids, the users created in order (stopping at the first failure), a plugin's
 * schedule turned on or off.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import { z } from 'zod'

const fetchApiDoubles = await vi.hoisted(async () => import('@test/fetchApiRoutes'))
vi.mock('../../api/client', fetchApiDoubles.clientWithMockedFetchApi)
vi.mock('../../store/authStore', () => ({ ...fetchApiDoubles.authStoreModule(), useAuthStore: { getState: () => ({ user: { username: 'admin-1', groups: ['admins'] } }) } }))

import { api } from '../../api/client'
import { resetExecutions } from './executionStore'
import { reviewImportId } from './reviewImportSchemas'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { approve, fieldOf as field, outcomeOf, renderApprovalCard, writes } from '@test/approvalCardHarness'
import type { CognitoUser } from '../../api/types'
import type { AssistantToolCall } from '../types'

const ALICE: CognitoUser = {
  username: 'u-alice', email: 'alice@example.com', name: 'Alice Doe', given_name: 'Alice', family_name: 'Doe',
  status: 'CONFIRMED', enabled: true, groups: ['users'], created_at: null, last_modified: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  resetFetchApi()
  resetExecutions()
  adminFlag.isAdmin = true
  vi.spyOn(api, 'getUsers').mockResolvedValue({ success: true, users: [ALICE] })
  return stubElementScrollIntoView()
})

const renderCard = (toolCall: AssistantToolCall, kind: 'scrapers' | 'settings' = 'scrapers') =>
  renderApprovalCard(toolCall, { kind, path: `/${kind}` })

/** The json-upload body the executor sends. */
const uploadBody = z.object({ source_id: z.string().optional(), items: z.array(z.record(z.string(), z.unknown())) })

describe('import_reviews card', () => {
  const REVIEWS = [
    { text: 'Checkout froze twice.', rating: 2, author: 'Sam', created_at: '2026-03-01' },
    { text: 'Love the new search.', rating: 5 },
    { text: 'Delivery was late again.' },
  ]
  const ARGS = { source_name: 'Support survey', items: REVIEWS }
  const card = (args: Record<string, unknown> = ARGS) => renderCard({ id: 'i1', name: 'import_reviews', args })

  it('is titled with the count and source and notes the undated rows', () => {
    card()
    expect(screen.getByRole('region', { name: 'Import 3 reviews from Support survey' })).toBeInTheDocument()
    expect(screen.getByText('2 reviews have no date; they are dated at import.')).toBeInTheDocument()
  })

  it('summarises the source, the profile and how many rows carry a rating or a date', () => {
    card()
    const values = ['source_name', 'source_id', 'count', 'rated', 'dated'].map((key) => field(key).getByRole('definition').textContent)
    expect(values).toStrictEqual(['Support survey', 'manual_import', '3 reviews', '2 of 3', '1 of 3'])
  })

  it('lists each row with its rating, author, date, title and link ("Not set" when the source gave none)', () => {
    card()
    const first = within(screen.getByTestId('review-row-0'))
    expect(['Checkout froze twice.', '2', 'Sam', '2026-03-01'].map((text) => first.getByText(text))).toHaveLength(4)
    expect(within(screen.getByTestId('review-row-2')).getAllByText('Not set')).toHaveLength(5)
  })

  it('lists EVERY row, with title and link, so no imported review goes unseen', () => {
    const items = Array.from({ length: 14 }, (_, i) => ({ text: `Review ${String(i)}`, title: `T${String(i)}`, url: `https://example.com/r/${String(i)}` }))
    card({ source_name: 'S', items })
    expect(screen.getAllByTestId(/^review-row-/)).toHaveLength(14)
    const last = within(screen.getByTestId('review-row-13'))
    expect(['Review 13', 'T13', 'https://example.com/r/13'].map((text) => last.getByText(text))).toHaveLength(3)
    expect(screen.getByText('Every review is listed; scroll to check every row before approving.')).toBeInTheDocument()
  })

  it('on approve, sends every row to json-upload under the named profile with a derived id and its channel', async () => {
    routeFetchApi({ 'POST /scrapers/manual/json-upload': () => ({ success: true, imported_count: 3, total_items: 3 }) })
    const { user, onResolve } = card({ ...ARGS, source_id: 'survey_q3' })
    await approve(user, onResolve)
    const sent = writes()
    expect(sent.map(([path, method]) => [path, method])).toStrictEqual([['/scrapers/manual/json-upload', 'POST']])
    const body = uploadBody.parse(sent[0]?.[2])
    expect([body.source_id, body.items[0]]).toStrictEqual(['survey_q3', {
      id: await reviewImportId('Support survey', REVIEWS[0] ?? { text: '' }), source: 'Support survey', text: 'Checkout froze twice.',
      timestamp: '2026-03-01', rating: 2, author: 'Sam',
    }])
    expect(outcomeOf(onResolve)).toMatchObject({ status: 'executed', data: { imported_count: 3, total_items: 3, source_id: 'survey_q3' } })
  })

  it('tags the upload as the assistant\'s, with the source the user named, for the import history', async () => {
    routeFetchApi({ 'POST /scrapers/manual/json-upload': () => ({ success: true, imported_count: 3, total_items: 3 }) })
    const { user, onResolve } = card()
    await approve(user, onResolve)
    expect(writes()[0]?.[2]).toMatchObject({ import_origin: 'assistant', source_label: 'Support survey' })
  })

  it('dates a row without a date at the approval time', async () => {
    routeFetchApi({ 'POST /scrapers/manual/json-upload': () => ({ success: true, imported_count: 3, total_items: 3 }) })
    const { user, onResolve } = card()
    await approve(user, onResolve)
    const undated = uploadBody.shape.items.element.parse(uploadBody.parse(writes()[0]?.[2]).items[2])
    expect(z.iso.datetime().safeParse(undated.timestamp).success).toBe(true)
  })

  it('derives the same id for the same review on every import, and a different one for another review', async () => {
    const again = await reviewImportId('Support survey', { text: 'Checkout froze twice.', author: 'Sam', created_at: '2026-03-01' })
    expect(await reviewImportId('Support survey', { text: 'Checkout froze twice.', author: 'Sam', created_at: '2026-03-01', rating: 1 })).toBe(again)
    expect(await reviewImportId('Support survey', { text: 'Checkout froze once.', author: 'Sam', created_at: '2026-03-01' })).not.toBe(again)
    expect(again).toMatch(/^ai-import-v1-[0-9a-f]{40}$/)
  })
})

describe('create_users card', () => {
  const USERS = [{ email: 'bob@example.com', role: 'users', given_name: 'Bob' }, { email: 'cy@example.com', role: 'admins' }, { email: 'di@example.com', role: 'users' }]
  const card = (users: Record<string, unknown>[] = USERS) => renderCard({ id: 'u1', name: 'create_users', args: { users } }, 'settings')
  const created: unknown[] = []
  const createAs = (failOn?: string) => vi.spyOn(api, 'createUser').mockImplementation((body) => {
    if (body.email === failOn) return Promise.reject(new Error('API Error: 500'))
    created.push(body.email)
    return Promise.resolve({ success: true, user: { ...ALICE, username: `u-${body.email.split('@')[0] ?? ''}`, email: body.email } })
  })
  beforeEach(() => { created.length = 0 })

  it('is titled with the count and carries the passwords note', () => {
    card()
    expect(screen.getByRole('region', { name: 'Create 3 users' })).toBeInTheDocument()
    expect(screen.getByText('Cognito emails each person a temporary password. Nothing else is created or changed.')).toBeInTheDocument()
  })

  it('lists every person with their role and "Not set" for a missing name; an administrator is flagged', () => {
    card()
    const bob = within(screen.getByTestId('user-row-bob@example.com'))
    expect([bob.getByText('Bob'), bob.getByText('Not set')]).toHaveLength(2)
    expect(bob.getByText('User')).toHaveClass('badge', 'badge-muted')
    expect(within(screen.getByTestId('user-row-cy@example.com')).getByText('Administrator')).toHaveClass('badge', 'badge-warn')
    expect(screen.getByText('1 of 3 will be administrators, with full access to settings, users and data.')).toBeInTheDocument()
  })

  it('shows no administrator note when nobody becomes an administrator', () => {
    card([{ email: 'bob@example.com', role: 'users' }])
    expect(screen.queryByText(/will be administrators/)).not.toBeInTheDocument()
  })

  it('on approve, creates them in order and returns every minted username', async () => {
    createAs()
    const { user, onResolve, invalidate } = card()
    await approve(user, onResolve)
    expect(created).toStrictEqual(['bob@example.com', 'cy@example.com', 'di@example.com'])
    expect(outcomeOf(onResolve)).toMatchObject({ status: 'executed', data: { users: [{ email: 'bob@example.com', username: 'u-bob' }, { email: 'cy@example.com', username: 'u-cy' }, { email: 'di@example.com', username: 'u-di' }] } })
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(['users'])
  })

  it('stops at the first failure and reports who was created and who was not', async () => {
    createAs('cy@example.com')
    const { user, onResolve } = card()
    await approve(user, onResolve)
    expect(created).toStrictEqual(['bob@example.com'])
    expect(outcomeOf(onResolve)).toStrictEqual({
      status: 'failed',
      error: 'Creating users stopped at cy@example.com: The request failed (HTTP 500). Created before that: '
        + 'bob@example.com (username u-bob). Not created: cy@example.com, di@example.com.',
    })
  })

  it('refuses the whole card when one email is already registered, and creates nobody', async () => {
    createAs()
    const { user, onResolve } = card([...USERS, { email: 'ALICE@example.com', role: 'users' }])
    await approve(user, onResolve)
    expect(created).toStrictEqual([])
    expect(outcomeOf(onResolve)).toStrictEqual({
      status: 'failed',
      error: 'A user with email "ALICE@example.com" already exists (username u-alice); nothing was created. To change them, propose update_user.',
    })
  })
})

describe('set_source_enabled card', () => {
  const card = (enabled: boolean) => renderCard({ id: 's1', name: 'set_source_enabled', args: { source: 'webscraper', enabled } })

  it('shows the plugin and its new state as an ok / muted badge', () => {
    card(true)
    expect(screen.getByRole('region', { name: 'Turn on the webscraper schedule' })).toBeInTheDocument()
    expect(field('source').getByText('webscraper')).toBeInTheDocument()
    expect(field('schedule').getByText('On')).toHaveClass('badge-ok')
  })

  it.each([
    [true, 'enableSource', 'Enabled the webscraper schedule; scheduled imports run again. Nothing already imported changed.'],
    [false, 'disableSource', 'Disabled the webscraper schedule; no scheduled imports run until it is enabled. Nothing already imported changed.'],
  ] as const)('enabled=%s calls %s and refreshes the schedule list', async (enabled, method, summary) => {
    const spy = vi.spyOn(api, method).mockResolvedValue({ success: true, source: 'webscraper', enabled })
    const { user, onResolve, invalidate } = card(enabled)
    await approve(user, onResolve)
    expect(spy.mock.calls).toStrictEqual([['webscraper']])
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'executed', summary, data: { source: 'webscraper', enabled } })
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(['sources-status'])
  })
})
