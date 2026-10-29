/**
 * Participants approval cards (add_participants, create_participant_list):
 * every row is rendered deterministically from the args, repeats of one
 * address collapse to their first row with a note, the list is named from
 * GET /participants/lists, and approval runs the engagement routes with the
 * user's own token — open to every signed-in user, not admin-only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import { z } from 'zod'

const fetchApiDoubles = await vi.hoisted(async () => import('@test/fetchApiRoutes'))
vi.mock('../../api/client', fetchApiDoubles.clientWithMockedFetchApi)
vi.mock('../../store/authStore', () => ({ ...fetchApiDoubles.authStoreModule(), useAuthStore: { getState: () => ({ user: { username: 'user-1', groups: ['users'] } }) } }))

import { resetExecutions } from './executionStore'
import { uniquePeople } from './participantSchemas'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { approve, fieldOf as field, outcomeOf, renderApprovalCard, writes } from '@test/approvalCardHarness'
import type { AssistantToolCall } from '../types'

const LIST_ID = 'lst_0123456789abcdef'
const LISTS = { lists: [{ list_id: LIST_ID, name: 'Acme beta customers', kind: 'beta', description: '', member_count: 2 }] }
const PEOPLE = [
  { email: 'ana.lopez@example.com', name: 'Ana Lopez', company: 'Example Air', title: 'Cabin crew lead', tags: ['crew', 'beta'] },
  { email: 'ben@acme.example' },
  { email: 'ANA.LOPEZ@example.com', name: 'Ana again' },
]
const ADD_RESULT = { added: 1, already: 0, created: 1, rejected: [{ email: 'ben@acme.example', reason: 'external_not_allowed' }] }

beforeEach(() => {
  vi.clearAllMocks()
  resetFetchApi()
  resetExecutions()
  adminFlag.isAdmin = false
  return stubElementScrollIntoView()
})

const renderCard = (toolCall: AssistantToolCall) => renderApprovalCard(toolCall, { kind: 'participants', path: '/participants' })
const membersBody = z.object({ people: z.array(z.record(z.string(), z.unknown())), origin: z.string().optional() })

describe('add_participants card', () => {
  const card = (people: Record<string, unknown>[] = PEOPLE, listId = LIST_ID) =>
    renderCard({ id: 'a1', name: 'add_participants', args: { list_id: listId, people } })

  it('names the stored list and counts the people once each', async () => {
    routeFetchApi({ 'GET /participants/lists': () => LISTS })
    card()
    expect(screen.getByRole('region', { name: 'Add 2 people to a participant list' })).toBeInTheDocument()
    expect(await field('list').findByText('Acme beta customers')).toBeInTheDocument()
    expect(field('count').getByRole('definition').textContent).toBe('2 people')
  })

  it('says the list is being read instead of showing its raw id while the lists load', () => {
    routeFetchApi({ 'GET /participants/lists': () => new Promise(() => undefined) })
    card()
    expect(field('list').getByText('Reading the list…')).toBeInTheDocument()
    expect(screen.queryByText(LIST_ID)).not.toBeInTheDocument()
  })

  it('shows the id with a note only when the lists cannot be read', async () => {
    routeFetchApi({}, { missStatus: 500 })
    card()
    expect(await screen.findByText(/The participant lists could not be read/)).toBeInTheDocument()
    expect(field('list').getByText(LIST_ID)).toBeInTheDocument()
  })

  it('lists each row with its fields ("Not set" when absent) and collapses a repeated address to its first row', () => {
    routeFetchApi({ 'GET /participants/lists': () => LISTS })
    card()
    expect(screen.getAllByTestId(/^participant-row-/)).toHaveLength(2)
    const first = within(screen.getByTestId('participant-row-0'))
    expect(['ana.lopez@example.com', 'Ana Lopez', 'Example Air', 'Cabin crew lead', 'crew, beta'].map((text) => first.getByText(text))).toHaveLength(5)
    expect(screen.queryByText('Ana again')).not.toBeInTheDocument()
    expect(within(screen.getByTestId('participant-row-1')).getAllByText('Not set')).toHaveLength(4)
  })

  it('notes how many repeated addresses were collapsed', () => {
    routeFetchApi({ 'GET /participants/lists': () => LISTS })
    card()
    expect(screen.getByText('1 repeated email address was collapsed to its first row.')).toBeInTheDocument()
  })

  it('lists EVERY row of a large paste, scrollable, so nobody is added unseen', () => {
    routeFetchApi({ 'GET /participants/lists': () => LISTS })
    card(Array.from({ length: 150 }, (_, i) => ({ email: `p${String(i)}@example.com` })))
    expect(screen.getAllByTestId(/^participant-row-/)).toHaveLength(150)
    expect(within(screen.getByTestId('participant-row-149')).getByText('p149@example.com')).toBeInTheDocument()
    expect(screen.getByTestId('participant-rows')).toHaveClass('max-h-80', 'overflow-auto')
    expect(screen.getByText('Every person is listed; scroll to check every row before approving.')).toBeInTheDocument()
  })

  it('carries no repeat note when every address is distinct', () => {
    routeFetchApi({ 'GET /participants/lists': () => LISTS })
    card([{ email: 'a@example.com' }, { email: 'b@example.com' }])
    expect(screen.queryByText(/repeated email/)).not.toBeInTheDocument()
  })

  it('says when the list no longer exists', async () => {
    routeFetchApi({ 'GET /participants/lists': () => ({ lists: [] }) })
    card()
    expect(await screen.findByText('This list was not found, so approving will add no one.')).toBeInTheDocument()
    expect(field('list').getByText(LIST_ID)).toBeInTheDocument()
  })

  const routeAdd = () => routeFetchApi({
    'GET /participants/lists': () => LISTS,
    [`POST /participants/lists/${LIST_ID}/members`]: () => ADD_RESULT,
  })

  it('on approve (a users-role caller), posts each address once', async () => {
    routeAdd()
    const { user, onResolve } = card()
    await approve(user, onResolve)
    const sent = writes()
    expect(sent.map(([path, method]) => [path, method])).toStrictEqual([[`/participants/lists/${LIST_ID}/members`, 'POST']])
    expect(membersBody.parse(sent[0]?.[2]).people).toStrictEqual([
      { email: 'ana.lopez@example.com', name: 'Ana Lopez', company: 'Example Air', title: 'Cabin crew lead', tags: ['crew', 'beta'] },
      { email: 'ben@acme.example' },
    ])
  })

  it('on approve, marks the people it creates as added by the assistant', async () => {
    routeAdd()
    const { user, onResolve } = card()
    await approve(user, onResolve)
    expect(membersBody.parse(writes()[0]?.[2]).origin).toBe('assistant')
  })

  it('reports the route\u2019s outcome on the card and refreshes every participants read', async () => {
    routeAdd()
    const { user, onResolve, invalidate } = card()
    await approve(user, onResolve)
    const summary = `Sent 2 people to participant list ${LIST_ID}: 1 added, 0 already on the list, 1 newly created, 1 rejected. `
      + 'Not added: ben@acme.example (external_not_allowed). Repeated rows dropped (same address): 1.'
    expect(outcomeOf(onResolve)).toStrictEqual({
      status: 'executed', summary,
      data: { list_id: LIST_ID, sent: 2, duplicates_collapsed: 1, ...ADD_RESULT },
    })
    await waitFor(() => expect(screen.getByText(summary)).toBeInTheDocument())
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(['participants'])
  })

  it('reports a failed write without claiming anyone was added', async () => {
    routeFetchApi({ 'GET /participants/lists': () => LISTS })
    const { user, onResolve } = card()
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toMatchObject({ status: 'failed' })
  })
})

describe('create_participant_list card', () => {
  const card = (args: Record<string, unknown> = { name: 'Paid panel', kind: 'paid', description: 'Paid research panel' }) =>
    renderCard({ id: 'c1', name: 'create_participant_list', args })

  it('shows the name, the kind as a label and the description', () => {
    card()
    expect(screen.getByRole('region', { name: 'Create the participant list Paid panel' })).toBeInTheDocument()
    expect(field('kind').getByText('Paid participants')).toHaveClass('badge', 'badge-muted')
    expect(field('description').getByText('Paid research panel')).toBeInTheDocument()
    expect(screen.getByText('The list starts empty; add people to it next.')).toBeInTheDocument()
  })

  it('on approve, posts the list and hands the new list_id back', async () => {
    const created = { list_id: 'lst_00000000000000aa', name: 'Paid panel', kind: 'paid', description: '', member_count: 0 }
    routeFetchApi({ 'POST /participants/lists': () => ({ list: created }) })
    const { user, onResolve } = card({ name: 'Paid panel', kind: 'paid' })
    await approve(user, onResolve)
    expect(writes()).toStrictEqual([['/participants/lists', 'POST', { name: 'Paid panel', kind: 'paid' }]])
    expect(outcomeOf(onResolve)).toStrictEqual({
      status: 'executed',
      summary: 'Created the participant list "Paid panel" (paid, list_id lst_00000000000000aa). Add people to it with add_participants and this list_id.',
      data: { list_id: 'lst_00000000000000aa', name: 'Paid panel', kind: 'paid' },
    })
  })
})

describe('uniquePeople', () => {
  it('keeps the first row of each address, compared case-insensitively', () => {
    expect(uniquePeople([{ email: 'a@example.com', name: 'A' }, { email: 'A@EXAMPLE.com' }, { email: 'b@example.com' }]))
      .toStrictEqual({ people: [{ email: 'a@example.com', name: 'A' }, { email: 'b@example.com' }], duplicates: 1 })
  })
})
