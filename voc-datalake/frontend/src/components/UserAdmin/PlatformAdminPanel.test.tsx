/**
 * Users → Platform admins: shown to platform admins only; a box per user, offered to administrators (and to a
 * platform admin, to revoke); one PUT per change; the server's refusals said in words.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import type { CognitoUser } from '../../api/types'
import { ApiError } from '../../lib/errors'

const platform = vi.hoisted(() => ({ isPlatformAdmin: true }))
const setPlatformAdmin = vi.fn<(username: string, platformAdmin: boolean) => Promise<unknown>>()
vi.mock('../../api/client', () => ({ api: { setPlatformAdmin: (username: string, value: boolean) => setPlatformAdmin(username, value) } }))
vi.mock('../../store/authStore', () => ({ useIsPlatformAdmin: () => platform.isPlatformAdmin }))

const { default: PlatformAdminPanel } = await import('./PlatformAdminPanel')

const user = (username: string, groups: string[], platformAdmin = false): CognitoUser => ({
  username, email: `${username}@example.com`, name: username, status: 'CONFIRMED', enabled: true, groups,
  platform_admin: platformAdmin, created_at: null, last_modified: null,
})
const box = (username: string) => screen.getByRole('checkbox', { name: `Platform admin: ${username}@example.com` })

beforeEach(() => {
  platform.isPlatformAdmin = true
  setPlatformAdmin.mockReset()
  setPlatformAdmin.mockResolvedValue({ success: true })
})

describe('PlatformAdminPanel', () => {
  it('shows nothing to anyone but a platform admin', () => {
    platform.isPlatformAdmin = false
    const { container } = renderWithQueryClient(<PlatformAdminPanel users={[user('ada', ['admins'], true)]} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('reflects who holds it, and offers a grant to administrators only', () => {
    renderWithQueryClient(<PlatformAdminPanel users={[user('ada', ['admins', 'platform-admins'], true), user('bo', ['admins']), user('vic', ['users'])]} />)
    expect(box('ada')).toBeChecked()
    expect(box('bo')).not.toBeChecked()
    expect(box('bo')).toBeEnabled()
    expect(box('vic')).toBeDisabled()
  })

  it('says, visibly and as its description, why a box is off', () => {
    renderWithQueryClient(<PlatformAdminPanel users={[user('vic', ['users'])]} />)
    expect(box('vic')).toHaveAccessibleDescription('Only an administrator can be a platform admin.')
  })

  it('grants and revokes through PUT /users/{username}/platform-admin', async () => {
    renderWithQueryClient(<PlatformAdminPanel users={[user('ada', ['admins'], true), user('bo', ['admins'])]} />)
    await userEvent.click(box('bo'))
    await waitFor(() => expect(setPlatformAdmin).toHaveBeenCalledWith('bo', true))
    await userEvent.click(box('ada'))
    await waitFor(() => expect(setPlatformAdmin).toHaveBeenLastCalledWith('ada', false))
  })

  it('says why revoking the last platform admin was refused', async () => {
    setPlatformAdmin.mockRejectedValue(new ApiError(409, 'This is the last enabled platform admin: make another administrator a platform admin first.'))
    renderWithQueryClient(<PlatformAdminPanel users={[user('ada', ['admins'], true)]} />)
    await userEvent.click(box('ada'))
    expect(await screen.findByRole('alert')).toHaveTextContent('This is the last enabled platform admin: make another administrator a platform admin first.')
  })
})
