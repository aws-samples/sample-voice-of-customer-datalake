/**
 * User-administration approval cards (create_user, update_user, set_user_access):
 * every field is rendered deterministically from the args, an update diffs
 * against the stored user (or grant) read at render, and approval runs the
 * admin-only REST writes in order — refusing a registered email, a user or
 * grant that changed, and the signed-in administrator's own role.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'

const fetchApiDoubles = await vi.hoisted(async () => import('@test/fetchApiRoutes'))
const SIGNED_IN = vi.hoisted(() => ({ username: 'admin-1', email: 'me@example.com', groups: ['admins'] }))
vi.mock('../../api/client', fetchApiDoubles.clientWithMockedFetchApi)
// The card gates on `useIsAdmin`; the update executor reads the signed-in user to refuse a self change.
vi.mock('../../store/authStore', () => ({ ...fetchApiDoubles.authStoreModule(), useAuthStore: { getState: () => ({ user: SIGNED_IN }) } }))

import { api } from '../../api/client'
import { resetExecutions } from './executionStore'
import { ACCESS_CHANGED_MESSAGE, SELF_CHANGE_MESSAGE, USER_CHANGED_MESSAGE } from './userExecutors'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { approve, fieldOf as field, outcomeOf, renderApprovalCard, resumedToolMessage, writes } from '@test/approvalCardHarness'
import type { CognitoUser } from '../../api/types'
import type { AssistantToolCall } from '../types'

const ME: CognitoUser = {
  username: 'admin-1', email: 'me@example.com', name: 'Me Admin', given_name: 'Me', family_name: 'Admin',
  status: 'CONFIRMED', enabled: true, groups: ['admins'], created_at: null, last_modified: null,
}
const ALICE: CognitoUser = {
  username: 'u-alice', email: 'alice@example.com', name: 'Alice Doe', given_name: 'Alice', family_name: 'Doe',
  status: 'CONFIRMED', enabled: true, groups: ['users'], created_at: '2026-01-01T00:00:00Z', last_modified: null,
}
const GRANT_ALL = { success: true, username: 'u-alice', all: true, categories: ['*'], sources: null, owned_categories: [] }
const USERS_LINK = { name: 'Open Privacy & access → Users', href: '/admin?tab=access&section=users' }
const OK = { success: true, message: 'ok' }

/**
 * `api.*` captured the client's own fetchApi when the module loaded, so the
 * user-admin methods are stubbed on the api object itself; each stub appends
 * `[method, ...args]` to {@link apiCalls}, so a spec asserts the exact client
 * calls in order. The grant routes go through the routed fetchApi double.
 */
const apiCalls: unknown[][] = []
const answering = <R,>(method: string, result: R) => (...args: unknown[]) => {
  apiCalls.push([method, ...args])
  return Promise.resolve(result)
}
const failing = (method: string) => (...args: unknown[]) => {
  apiCalls.push([method, ...args])
  return Promise.reject(new Error('API Error: 500'))
}

function stubUserApi(users: CognitoUser[] = [ME, ALICE]) {
  vi.spyOn(api, 'getUsers').mockResolvedValue({ success: true, users })
  vi.spyOn(api, 'createUser').mockImplementation(answering('createUser', { success: true, user: { ...ALICE, username: 'u-new', email: 'bob@example.com' } }))
  vi.spyOn(api, 'updateUser').mockImplementation(answering('updateUser', { ...OK, given_name: 'Alicia', family_name: 'Doe', name: 'Alicia Doe' }))
  vi.spyOn(api, 'updateUserGroup').mockImplementation(answering('updateUserGroup', OK))
  vi.spyOn(api, 'enableUser').mockImplementation(answering('enableUser', OK))
  vi.spyOn(api, 'disableUser').mockImplementation(answering('disableUser', OK))
}

beforeEach(() => {
  vi.clearAllMocks()
  apiCalls.length = 0
  resetFetchApi()
  resetExecutions()
  adminFlag.isAdmin = true
  stubUserApi()
  return stubElementScrollIntoView()
})

const renderCard = (toolCall: AssistantToolCall) => renderApprovalCard(toolCall, { kind: 'settings', path: '/settings' })

function grantRoutes(stored: Record<string, unknown> = GRANT_ALL) {
  routeFetchApi({ 'GET /users/u-alice/category-access': () => stored, 'PUT /users/u-alice/category-access': () => stored })
}

const diff = (key: string) => within(screen.getByTestId(`diff-${key}`))

describe('create_user card', () => {
  const CREATE = { email: 'bob@example.com', role: 'users', given_name: 'Bob' }
  const card = (args: Record<string, unknown> = CREATE) => renderCard({ id: 'c1', name: 'create_user', args })

  it('is titled with the email and says what the create does — and does not do', () => {
    card()
    expect(screen.getByRole('region', { name: 'Create user bob@example.com' })).toBeInTheDocument()
    expect(screen.getByText('Cognito emails this person a temporary password. Nothing else is created or changed.')).toBeInTheDocument()
    expect(screen.getByText('Nothing is saved until you approve.')).toBeInTheDocument()
  })

  it('shows email, the role as a muted label and the names (a missing one as "Not set")', () => {
    card()
    expect(field('email').getByText('bob@example.com')).toBeInTheDocument()
    expect(field('role').getByText('User')).toHaveClass('badge', 'badge-muted')
    expect(field('given_name').getByText('Bob')).toBeInTheDocument()
    expect(field('family_name').getByText('Not set')).toBeInTheDocument()
  })

  it('labels an administrator role', () => {
    card({ email: 'bob@example.com', role: 'admins' })
    expect(field('role').getByText('Administrator')).toBeInTheDocument()
  })

  it('on approve, re-reads the list, creates the user like Settings → Users does, refreshes the list and links to it', async () => {
    const { user, onResolve, invalidate } = card()
    await approve(user, onResolve)
    expect(apiCalls).toStrictEqual([['createUser', { username: 'bob@example.com', email: 'bob@example.com', group: 'users', given_name: 'Bob' }]])
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(['users'])
    expect(screen.getByRole('link', { name: USERS_LINK.name })).toHaveAttribute('href', USERS_LINK.href)
  })

  it('returns the minted username so the model can set access next', async () => {
    const { user, onResolve } = card()
    await approve(user, onResolve)
    expect(resumedToolMessage(onResolve, 'c1')).toStrictEqual({
      status: 'executed',
      summary: 'Created user bob@example.com (users) with username u-new; Cognito emailed them a temporary password. Nothing else was created.',
      data: { username: 'u-new', email: 'bob@example.com' },
    })
  })

  it('refuses an email that is registered right before executing (case-insensitively), and creates nothing', async () => {
    const { user, onResolve } = card({ email: 'ALICE@example.com', role: 'users' })
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({
      status: 'failed',
      error: 'A user with email "ALICE@example.com" already exists (username u-alice); nothing was created. To change them, propose update_user.',
    })
    expect(apiCalls).toStrictEqual([])
  })
})

describe('update_user card', () => {
  const UPDATES = { given_name: 'Alicia', role: 'admins', enabled: false }
  const card = (username = 'u-alice', updates: Record<string, unknown> = UPDATES) =>
    renderCard({ id: 'u1', name: 'update_user', args: { username, updates } })

  it('diffs the changed fields before → after against the stored user and collapses the rest', async () => {
    card()
    await screen.findByTestId('diff-given_name')
    const name = diff('given_name')
    expect([name.getByText('Alice'), name.getByText('Alicia')]).toHaveLength(2)
    expect([diff('role').getByText('User'), diff('role').getByText('Administrator')]).toHaveLength(2)
    expect([diff('enabled').getByText('Enabled'), diff('enabled').getByText('Disabled')]).toHaveLength(2)
    expect(screen.getByText('2 unchanged fields')).toBeInTheDocument()
  })

  it('renders enabled / disabled as a state: ok and muted tones', async () => {
    card()
    await screen.findByTestId('diff-enabled')
    expect(diff('enabled').getByText('Enabled')).toHaveClass('badge-ok')
    expect(diff('enabled').getByText('Disabled')).toHaveClass('badge-muted')
  })

  it('on approve, applies names (the merged pair), then the role, then the enabled state, and refreshes the list', async () => {
    const { user, onResolve, invalidate } = card()
    await screen.findByTestId('diff-given_name')
    await approve(user, onResolve)
    expect(apiCalls).toStrictEqual([
      ['updateUser', 'u-alice', { given_name: 'Alicia', family_name: 'Doe' }],
      ['updateUserGroup', 'u-alice', 'admins'],
      ['disableUser', 'u-alice'],
    ])
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'executed', summary: 'Updated user alice@example.com (name, role, enabled state).', data: { username: 'u-alice' } })
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toContainEqual(['users'])
  })

  it('stops at the first failing step and reports what was applied', async () => {
    vi.spyOn(api, 'updateUserGroup').mockImplementation(failing('updateUserGroup'))
    const { user, onResolve } = card()
    await screen.findByTestId('diff-given_name')
    await approve(user, onResolve)
    expect(apiCalls.map(([method]) => method)).toStrictEqual(['updateUser', 'updateUserGroup'])
    expect(outcomeOf(onResolve)).toStrictEqual({
      status: 'failed',
      error: 'Updating user alice@example.com stopped at the role: The request failed (HTTP 500). Applied before that: name. Not applied: role, enabled state.',
    })
  })

  it('refuses when the user changed after the card was shown, and changes nothing', async () => {
    const { user, onResolve } = card()
    await screen.findByTestId('diff-given_name')
    stubUserApi([ME, { ...ALICE, family_name: 'Edited-Elsewhere' }])
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'failed', error: USER_CHANGED_MESSAGE })
    expect(apiCalls).toStrictEqual([])
  })

  it('refuses to change the signed-in administrator\u2019s own role or enabled state', async () => {
    const { user, onResolve } = card('admin-1', { role: 'users' })
    await screen.findByTestId('diff-role')
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'failed', error: SELF_CHANGE_MESSAGE })
    expect(apiCalls).toStrictEqual([])
  })

  it('still lets the signed-in administrator change their own name', async () => {
    const { user, onResolve } = card('admin-1', { family_name: 'Renamed' })
    await screen.findByTestId('diff-family_name')
    await approve(user, onResolve)
    expect(apiCalls).toStrictEqual([['updateUser', 'admin-1', { given_name: 'Me', family_name: 'Renamed' }]])
  })

  it('says so when the user does not exist', async () => {
    card('u-ghost')
    expect(await screen.findByRole('alert')).toHaveTextContent('User u-ghost was not found, so approving will save nothing.')
  })
})

describe('set_user_access card', () => {
  const card = (args: Record<string, unknown>) => renderCard({ id: 'a1', name: 'set_user_access', args: { username: 'u-alice', ...args } })

  it('diffs categories and sources before → after against the stored grant', async () => {
    grantRoutes()
    card({ categories: ['delivery', 'billing'], sources: ['*'] })
    await screen.findByTestId('diff-categories')
    expect(diff('categories').getByText('All categories')).toBeInTheDocument()
    expect(diff('categories').getAllByRole('listitem').map((li) => li.textContent)).toStrictEqual(['billing', 'delivery'])
    expect(diff('sources').getByText('Every source that is not restricted (default)')).toBeInTheDocument()
    expect(diff('sources').getByText('Every source, restricted ones included')).toBeInTheDocument()
  })

  it('leaves the sources row unchanged when the args do not name them', async () => {
    grantRoutes()
    card({ categories: ['delivery'] })
    await screen.findByTestId('diff-categories')
    expect(screen.queryByTestId('diff-sources')).not.toBeInTheDocument()
    expect(screen.getByText('1 unchanged field')).toBeInTheDocument()
  })

  it('on approve, PUTs the grant as the Users page would, and refreshes the list and that user\u2019s grant', async () => {
    grantRoutes()
    const { user, onResolve, invalidate } = card({ categories: ['delivery', 'billing'], sources: ['*'] })
    await screen.findByTestId('diff-categories')
    await approve(user, onResolve)
    expect(writes()).toStrictEqual([['/users/u-alice/category-access', 'PUT', { categories: ['delivery', 'billing'], sources: ['*'] }]])
    expect(outcomeOf(onResolve)).toStrictEqual({
      status: 'executed', summary: 'Set access for user u-alice: 2 categories; sources: every source, restricted ones included.', data: { username: 'u-alice' },
    })
    expect(invalidate.mock.calls.map(([f]) => f?.queryKey)).toStrictEqual(expect.arrayContaining([['users'], ['user-category-access', 'u-alice']]))
    expect(screen.getByRole('link', { name: USERS_LINK.name })).toHaveAttribute('href', USERS_LINK.href)
  })

  it.each([
    ['omitted sources are left out of the body (unchanged)', { categories: ['delivery'] }, { categories: ['delivery'] }],
    ['null sources go back to the default rule', { categories: ['delivery'], sources: null }, { categories: ['delivery'], sources: null }],
    ['a source list is sent as is', { categories: ['delivery'], sources: ['web', 'ios_app'] }, { categories: ['delivery'], sources: ['web', 'ios_app'] }],
  ])('%s', async (_label, args, body) => {
    grantRoutes()
    const { user, onResolve } = card(args)
    await screen.findByTestId('diff-categories')
    await approve(user, onResolve)
    expect(writes().at(0)?.[2]).toStrictEqual(body)
  })

  it('refuses when the grant changed after the card was shown, and saves nothing', async () => {
    grantRoutes()
    const { user, onResolve } = card({ categories: ['delivery'] })
    await screen.findByTestId('diff-categories')
    grantRoutes({ ...GRANT_ALL, all: false, categories: ['billing'] })
    await approve(user, onResolve)
    expect(outcomeOf(onResolve)).toStrictEqual({ status: 'failed', error: ACCESS_CHANGED_MESSAGE })
    expect(writes()).toStrictEqual([])
  })
})

describe('admin gating on the card', () => {
  it('a non-admin cannot approve a user write', () => {
    adminFlag.isAdmin = false
    renderCard({ id: 'n1', name: 'create_user', args: { email: 'bob@example.com', role: 'users' } })
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()
    expect(screen.getByText('Only administrators can approve this action. You can still decline it.')).toBeInTheDocument()
  })
})
