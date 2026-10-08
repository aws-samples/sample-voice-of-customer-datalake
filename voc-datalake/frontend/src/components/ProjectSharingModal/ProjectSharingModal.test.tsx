/**
 * @fileoverview Sharing dialog behaviour: what a manager can do, what everyone
 * else sees read-only, and the confirm-guarded transfer / leave flows.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import type { ProjectMembersResponse } from '../../api/projectTypes'
import { projectKey, projectsKey } from '../../api/projectQueryKeys'

const mockGetMembers = vi.fn<(id: string) => Promise<unknown>>()
const mockSetVisibility = vi.fn<(id: string, v: string) => Promise<unknown>>()
const mockSearch = vi.fn<(id: string, q: string) => Promise<unknown>>()
const mockAddMember = vi.fn<(id: string, sub: string, role: string) => Promise<unknown>>()
const mockUpdateRole = vi.fn<(id: string, sub: string, role: string) => Promise<unknown>>()
const mockRemoveMember = vi.fn<(id: string, sub: string) => Promise<unknown>>()
const mockTransfer = vi.fn<(id: string, sub: string) => Promise<unknown>>()

vi.mock('../../api/projectsApi', () => ({
  projectsApi: {
    getMembers: (id: string) => mockGetMembers(id),
    setVisibility: (id: string, v: string) => mockSetVisibility(id, v),
    searchMemberCandidates: (id: string, q: string) => mockSearch(id, q),
    addMember: (id: string, sub: string, role: string) => mockAddMember(id, sub, role),
    updateMemberRole: (id: string, sub: string, role: string) => mockUpdateRole(id, sub, role),
    removeMember: (id: string, sub: string) => mockRemoveMember(id, sub),
    transferOwnership: (id: string, sub: string) => mockTransfer(id, sub),
  },
}))

const authState = { user: { username: 'me', email: 'me@example.com', groups: [], sub: 'sub-me' } }
vi.mock('../../store/authStore', () => ({
  useAuthStore: (selector: (state: typeof authState) => unknown) => selector(authState),
}))

import ProjectSharingModal from './ProjectSharingModal'

const OWNER = { sub: 'sub-owner', username: 'olivia', email: 'olivia@example.com' }
const VIEWER = { sub: 'sub-vic', role: 'viewer' as const, username: 'vic', email: 'vic@example.com' }
const SELF_EDITOR = { sub: 'sub-me', role: 'editor' as const, username: 'me', email: 'me@example.com' }

function membersResponse(overrides: Partial<ProjectMembersResponse> = {}): ProjectMembersResponse {
  return {
    visibility: 'private',
    owner: OWNER,
    members: [VIEWER],
    access: { role: 'owner', can_view: true, can_edit: true, can_manage: true },
    ...overrides,
  }
}

const READ_ONLY_ACCESS = { role: 'editor' as const, can_view: true, can_edit: true, can_manage: false }

function renderModal(props: Partial<React.ComponentProps<typeof ProjectSharingModal>> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
  const onClose = vi.fn()
  const onLeft = vi.fn()
  render(
    <ProjectSharingModal isOpen onClose={onClose} onLeft={onLeft} projectId="proj_1" projectName="Q1" {...props} />,
    { wrapper },
  )
  return { onClose, onLeft, queryClient }
}

describe('ProjectSharingModal', () => {
  beforeEach(() => {
    mockGetMembers.mockResolvedValue(membersResponse())
    mockSetVisibility.mockResolvedValue({ success: true, visibility: 'public' })
    mockSearch.mockResolvedValue([])
    mockAddMember.mockResolvedValue({ member: null })
    mockUpdateRole.mockResolvedValue({ member: null })
    mockRemoveMember.mockResolvedValue({ success: true })
    mockTransfer.mockResolvedValue({ success: true })
  })

  it('is a dialog named by its heading, with focus moved inside', async () => {
    renderModal()
    const dialog = screen.getByRole('dialog', { name: 'Share "Q1"' })
    expect(dialog).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toHaveFocus()
    await screen.findByText('olivia')
  })

  describe('as a manager', () => {
    it('shows the owner, members and the current visibility', async () => {
      renderModal()

      expect(await screen.findByText('olivia')).toBeInTheDocument()
      expect(screen.getByText('vic')).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /Private/ })).toBeChecked()
    })

    it('offers every manage control on a member row', async () => {
      renderModal()

      expect(await screen.findByRole('combobox', { name: 'Role for vic' })).toHaveValue('viewer')
      expect(screen.getByRole('button', { name: 'Remove vic' })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Make vic the owner' })).toBeInTheDocument()
    })

    it('offers the invite search and no read-only note', async () => {
      renderModal()

      expect(await screen.findByRole('searchbox', { name: 'Search users' })).toBeInTheDocument()
      expect(screen.queryByText(/Only the project owner or an admin/)).not.toBeInTheDocument()
    })

    it('shows each person\'s email under their name', async () => {
      renderModal()

      expect(await screen.findByText('olivia@example.com')).toBeInTheDocument()
      expect(screen.getByText('vic@example.com')).toBeInTheDocument()
    })

    it('changes visibility', async () => {
      const user = userEvent.setup()
      renderModal()
      await user.click(await screen.findByRole('radio', { name: /Public/ }))
      await waitFor(() => expect(mockSetVisibility).toHaveBeenCalledWith('proj_1', 'public'))
    })

    it('changes a member role and removes a member', async () => {
      const user = userEvent.setup()
      renderModal()

      await user.selectOptions(await screen.findByRole('combobox', { name: 'Role for vic' }), 'editor')
      await waitFor(() => expect(mockUpdateRole).toHaveBeenCalledWith('proj_1', 'sub-vic', 'editor'))

      await user.click(screen.getByRole('button', { name: 'Remove vic' }))
      await waitFor(() => expect(mockRemoveMember).toHaveBeenCalledWith('proj_1', 'sub-vic'))
    })

    it('keeps Invite disabled until someone is picked', async () => {
      renderModal()

      expect(await screen.findByRole('button', { name: 'Invite' })).toBeDisabled()
    })

    it('searches once three characters are typed and invites the picked user with the chosen role', async () => {
      mockSearch.mockResolvedValue([{ sub: 'sub-eddie', username: 'eddie', email: 'eddie@example.com' }])
      const user = userEvent.setup()
      renderModal()

      const invite = await screen.findByRole('button', { name: 'Invite' })

      await user.type(screen.getByRole('searchbox', { name: 'Search users' }), 'edd')
      await user.click(await screen.findByRole('button', { name: 'Select eddie' }))
      expect(mockSearch).toHaveBeenCalledWith('proj_1', 'edd')
      expect(screen.getByText('Selected: eddie')).toBeInTheDocument()

      await user.selectOptions(screen.getByRole('combobox', { name: 'Role for the invited person' }), 'editor')
      await user.click(invite)

      await waitFor(() => expect(mockAddMember).toHaveBeenCalledWith('proj_1', 'sub-eddie', 'editor'))
      await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search users' })).toHaveValue(''))
    })

    it('strips characters the candidates endpoint rejects before searching', async () => {
      const user = userEvent.setup()
      renderModal()
      await user.type(await screen.findByRole('searchbox', { name: 'Search users' }), 'a"b\\c')
      await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('proj_1', 'abc'))
      expect(mockSearch.mock.calls.every(([, q]) => typeof q === 'string' && !/["\\]/.test(q))).toBe(true)
    })

    it('does not search below three characters and describes the minimum', async () => {
      const user = userEvent.setup()
      renderModal()
      const search = await screen.findByRole('searchbox', { name: 'Search users' })
      expect(search).toHaveAccessibleDescription('Type at least 3 characters to search.')

      await user.type(search, 'ed')
      // Longer than the debounce, so a search would have fired by now.
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(mockSearch).not.toHaveBeenCalled()

      await user.type(search, ' ')
      await new Promise((resolve) => setTimeout(resolve, 400))
      expect(mockSearch).not.toHaveBeenCalled()

      await user.type(search, 'd')
      await waitFor(() => expect(mockSearch).toHaveBeenCalledWith('proj_1', 'ed d'))
    })

    async function openTransferConfirm(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
      renderModal()
      await user.click(await screen.findByRole('button', { name: 'Make vic the owner' }))
      return screen.findByRole('dialog', { name: /Transfer ownership\?/ })
    }

    it('transfers ownership only after confirming', async () => {
      const user = userEvent.setup()
      const confirm = await openTransferConfirm(user)
      expect(within(confirm).getByText(/vic will become the owner/)).toBeInTheDocument()
      expect(mockTransfer).not.toHaveBeenCalled()

      await user.click(within(confirm).getByRole('button', { name: 'Transfer' }))
      await waitFor(() => expect(mockTransfer).toHaveBeenCalledWith('proj_1', 'sub-vic'))
    })

    it('does not transfer when the confirmation is cancelled', async () => {
      const user = userEvent.setup()
      const confirm = await openTransferConfirm(user)
      await user.click(within(confirm).getByRole('button', { name: 'Cancel' }))
      await waitFor(() => expect(screen.queryByRole('dialog', { name: /Transfer ownership\?/ })).not.toBeInTheDocument())
      expect(mockTransfer).not.toHaveBeenCalled()
    })

    it('explains a 409 from the invite call', async () => {
      mockSearch.mockResolvedValue([{ sub: 'sub-eddie', username: 'eddie', email: '' }])
      mockAddMember.mockRejectedValue(new Error('API Error: 409'))
      const user = userEvent.setup()
      renderModal()

      await user.type(await screen.findByRole('searchbox', { name: 'Search users' }), 'edd')
      await user.click(await screen.findByRole('button', { name: 'Select eddie' }))
      await user.click(screen.getByRole('button', { name: 'Invite' }))

      expect(await screen.findByRole('alert')).toHaveTextContent('That person already has access to this project.')
    })
  })

  describe('as a non-manager', () => {
    const READ_ONLY_NOTE = 'Only the project owner or an admin can change sharing.'

    /** Mount the dialog for a caller who can edit the project but not manage its sharing. */
    function renderReadOnly(overrides: Partial<ProjectMembersResponse> = {}) {
      mockGetMembers.mockResolvedValue(membersResponse({ access: READ_ONLY_ACCESS, ...overrides }))
      return renderModal()
    }

    it('renders read-only: the note and the visibility as a badge', async () => {
      renderReadOnly()

      expect(await screen.findByText(READ_ONLY_NOTE)).toBeInTheDocument()
      expect(screen.getByTestId('project-visibility-badge')).toHaveTextContent('Private')
    })

    it('renders read-only: the owner and members with their role as text', async () => {
      renderReadOnly()

      expect(await screen.findByText('olivia')).toBeInTheDocument()
      expect(screen.getByText('vic')).toBeInTheDocument()
      expect(screen.getByText('Can view')).toBeInTheDocument()
    })

    it.each([
      ['visibility toggle', () => screen.queryByRole('radio')],
      ['role select', () => screen.queryByRole('combobox')],
      ['remove button', () => screen.queryByRole('button', { name: /Remove/ })],
      ['transfer button', () => screen.queryByRole('button', { name: /owner/ })],
      ['invite search', () => screen.queryByRole('searchbox')],
      ['leave button (not a member)', () => screen.queryByRole('button', { name: 'Leave project' })],
    ])('renders read-only: no %s', async (_control, query) => {
      renderReadOnly()

      await screen.findByText(READ_ONLY_NOTE)
      expect(query()).not.toBeInTheDocument()
    })

    // On a public project every signed-in user can open this dialog, so the member
    // list must not double as a directory of addresses. Only a manager sees emails.
    it('shows no email for the owner or any member', async () => {
      renderReadOnly()

      expect(await screen.findByText('olivia')).toBeInTheDocument()
      expect(screen.queryByText('olivia@example.com')).not.toBeInTheDocument()
      expect(screen.queryByText('vic@example.com')).not.toBeInTheDocument()
      expect(screen.queryByText(/@example\.com/)).not.toBeInTheDocument()
    })

    it('falls back to the sub, not the email, for a member without a username', async () => {
      const anonymous = { sub: 'sub-anon', role: 'viewer' as const, username: '', email: 'anon@example.com' }
      renderReadOnly({ members: [anonymous] })

      expect(await screen.findByText('sub-anon')).toBeInTheDocument()
      expect(screen.queryByText('anon@example.com')).not.toBeInTheDocument()
    })

    it('lets a member leave from their own row after confirming', async () => {
      const user = userEvent.setup()
      const { onClose, onLeft } = renderReadOnly({ members: [VIEWER, SELF_EDITOR] })

      await screen.findByText('(you)')
      await user.click(screen.getByRole('button', { name: 'Leave project' }))
      const confirm = await screen.findByRole('dialog', { name: 'Leave project?' })
      await user.click(within(confirm).getByRole('button', { name: 'Leave' }))

      await waitFor(() => expect(mockRemoveMember).toHaveBeenCalledWith('proj_1', 'sub-me'))
      await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1))
      expect(onClose).toHaveBeenCalledWith()
    })

    it('offers Leave only on the caller\'s own row', async () => {
      renderReadOnly({ members: [VIEWER, SELF_EDITOR] })

      expect(await screen.findByText('(you)')).toBeInTheDocument()
      expect(screen.getAllByRole('button', { name: 'Leave project' })).toHaveLength(1)
    })

    it('drops the left project from the cache before onLeft, so nothing refetches it', async () => {
      mockGetMembers.mockResolvedValue(membersResponse({ access: READ_ONLY_ACCESS, members: [SELF_EDITOR] }))
      const user = userEvent.setup()
      const cachedAtLeave: unknown[] = []
      const { queryClient } = renderModal({
        onLeft: () => {
          cachedAtLeave.push(queryClient.getQueryData(projectKey('proj_1')))
        },
      })
      queryClient.setQueryData(projectKey('proj_1'), { project: { project_id: 'proj_1' } })
      queryClient.setQueryData(projectsKey(), { projects: [] })

      await user.click(await screen.findByRole('button', { name: 'Leave project' }))
      const confirm = await screen.findByRole('dialog', { name: 'Leave project?' })
      await user.click(within(confirm).getByRole('button', { name: 'Leave' }))

      await waitFor(() => expect(cachedAtLeave).toHaveLength(1))
      expect(cachedAtLeave[0]).toBeUndefined()
      // The detail query is gone, not merely invalidated (which would refetch -> 404).
      expect(queryClient.getQueryCache().find({ queryKey: projectKey('proj_1'), exact: true })).toBeUndefined()
      expect(queryClient.getQueryState(projectsKey())?.isInvalidated).toBe(true)
    })

    it('treats an access-less members response as read-only (fail closed)', async () => {
      mockGetMembers.mockResolvedValue({ ...membersResponse(), access: { role: null, can_view: true, can_edit: false, can_manage: false } })
      renderModal()
      expect(await screen.findByText('Only the project owner or an admin can change sharing.')).toBeInTheDocument()
      expect(screen.queryByRole('searchbox')).not.toBeInTheDocument()
    })
  })

  it('shows an error when the members call fails', async () => {
    mockGetMembers.mockRejectedValue(new Error('API Error: 500'))
    renderModal()
    expect(await screen.findByRole('alert')).toHaveTextContent('Sharing settings could not be loaded.')
  })

  it('does not fetch while closed', () => {
    renderModal({ isOpen: false })
    expect(mockGetMembers).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
