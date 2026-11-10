/**
 * @fileoverview Users → flags: memory reviewer for anyone, fallback owner for
 * admins only (a non-admin who holds it may still clear it), one PUT per
 * change, a users refetch after every save, and the panel's visible copy.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import type { CognitoUser } from '../../api/types'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))

const { default: UserFlagsPanel } = await import('./UserFlagsPanel')

const user = (username: string, groups: string[], flags?: Record<string, boolean>): CognitoUser & { flags?: Record<string, boolean> } => ({
  username, email: `${username}@example.com`, name: username, status: 'CONFIRMED', enabled: true, groups, created_at: null, last_modified: null,
  ...(flags ? { flags } : {}),
})

beforeEach(() => {
  fetchApi.mockReset()
  fetchApi.mockResolvedValue({ flags: {} })
})

describe('UserFlagsPanel', () => {
  it('reflects stored flags and treats a missing flags object as off', () => {
    renderWithQueryClient(<UserFlagsPanel users={[user('ada', ['admins'], { fallback_owner: true, memory_reviewer: false }), user('vic', ['users'])]} />)
    expect(screen.getByRole('checkbox', { name: 'Fallback owner: ada@example.com' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Memory reviewer: vic@example.com' })).not.toBeChecked()
  })

  it('does not offer fallback owner to a non-admin', () => {
    renderWithQueryClient(<UserFlagsPanel users={[user('vic', ['users'])]} />)
    expect(screen.getByRole('checkbox', { name: 'Fallback owner: vic@example.com' })).toBeDisabled()
  })

  it('PUTs the one flag that changed', async () => {
    renderWithQueryClient(<UserFlagsPanel users={[user('vic', ['users'])]} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Memory reviewer: vic@example.com' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/users/vic/flags', { method: 'PUT', body: '{"memory_reviewer":true}' }))
  })
})

const fallbackBox = (email: string) => screen.getByRole('checkbox', { name: `Fallback owner: ${email}` })

describe('the panel copy comes from the components namespace', () => {
  it('shows the title, the description and both column labels', () => {
    renderWithQueryClient(<UserFlagsPanel users={[user('ada', ['admins'])]} />)
    expect(screen.getByRole('group', { name: 'Memory & ownership flags' })).toBeInTheDocument()
    expect(screen.getByText('Memory reviewers curate company memory. The fallback owner (one admin) receives agent-created projects whose category has no owner.')).toBeInTheDocument()
    expect(screen.getByText('Fallback owner', { selector: 'label' })).toBeInTheDocument()
    expect(screen.getByText('Memory reviewer', { selector: 'label' })).toBeInTheDocument()
  })

  it('explains the admin-only rule on a non-admin row, and only there', () => {
    renderWithQueryClient(<UserFlagsPanel users={[user('ada', ['admins']), user('vic', ['users'])]} />)
    expect(fallbackBox('vic@example.com').closest('label')).toHaveAttribute('title', 'Only an admin can be the fallback owner.')
    expect(fallbackBox('ada@example.com').closest('label')).not.toHaveAttribute('title')
  })
})

describe('fallback owner', () => {
  it('is offered to an admin, and checking it PUTs fallback_owner', async () => {
    renderWithQueryClient(<UserFlagsPanel users={[user('ada', ['admins'])]} />)
    expect(fallbackBox('ada@example.com')).toBeEnabled()
    await userEvent.click(fallbackBox('ada@example.com'))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/users/ada/flags', { method: 'PUT', body: '{"fallback_owner":true}' }))
  })

  it('stays clearable on a non-admin who already holds it', () => {
    renderWithQueryClient(<UserFlagsPanel users={[user('vic', ['users'], { fallback_owner: true })]} />)
    expect(fallbackBox('vic@example.com')).toBeEnabled()
  })
})

describe('saving', () => {
  it('refetches the users once the save settles (the server may clear another fallback owner)', async () => {
    const client = createTestQueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    renderWithQueryClient(<UserFlagsPanel users={[user('vic', ['users'])]} />, client)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Memory reviewer: vic@example.com' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['users'] }))
  })

  it('shows the failure alert when the PUT fails', async () => {
    fetchApi.mockRejectedValue(new Error('boom'))
    renderWithQueryClient(<UserFlagsPanel users={[user('vic', ['users'])]} />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'Memory reviewer: vic@example.com' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not update the flag. Try again.')
  })
})
