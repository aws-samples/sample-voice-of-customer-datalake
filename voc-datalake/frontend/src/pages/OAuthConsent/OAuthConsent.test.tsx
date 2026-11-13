/**
 * The MCP OAuth consent screen (docs/mcp.md "OAuth sign-in"): it describes the request it was given,
 * approves with exactly the chosen access, and denies back to the assistant.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'

const describeConsent = vi.fn<(query: string) => unknown>()
const approveConsent = vi.fn<(choice: unknown) => unknown>()

vi.mock('../../api/oauthApi', () => ({
  oauthConsentKey: (query: string) => ['connect', 'oauth', 'consent', query],
  oauthApi: {
    describeConsent: (query: string) => describeConsent(query),
    approveConsent: (choice: unknown) => approveConsent(choice),
  },
}))
vi.mock('../../api/projectsApi', () => ({
  projectsApi: { getProjects: () => Promise.resolve({ projects: [{ project_id: 'proj_1', name: 'Checkout revamp' }] }) },
}))

const assign = vi.fn<(url: string) => void>()
vi.mock('./leaveApp', () => ({ leaveTo: (url: string) => assign(url) }))

const { default: OAuthConsent } = await import('./OAuthConsent')
const { setCurrentWorkspace } = await import('../../workspace/currentWorkspace')
const { ApiError } = await import('../../lib/errors')

const QUERY = 'response_type=code&client_id=kiro-client&state=abc'
const DESCRIBED = {
  refused: false, client_kind: 'kiro', client_name: 'Kiro', can_write: true, can_run_agents: false, loopback: true,
  deny_redirect: 'http://127.0.0.1:53111/oauth/callback?error=access_denied&state=abc',
}

beforeEach(() => {
  describeConsent.mockReset()
  approveConsent.mockReset()
  assign.mockReset()
  describeConsent.mockResolvedValue(DESCRIBED)
  setCurrentWorkspace(null)
})

function renderConsent(query = QUERY) {
  const path = query ? `/oauth/authorize?${query}` : '/oauth/authorize'
  return renderWithQueryClient(<TestRouter initialEntries={[path]}><OAuthConsent /></TestRouter>)
}

describe('OAuthConsent', () => {
  it('asks on behalf of the named client, reading the query it was given', async () => {
    renderConsent()

    expect(await screen.findByText('Kiro asks to use VoC as you.')).toBeInTheDocument()
    expect(describeConsent).toHaveBeenCalledWith(QUERY)
    expect(screen.getByRole('radio', { name: /Read only/ })).toBeChecked()
  })

  it('approves with the chosen scope and project, then leaves for the sign-in', async () => {
    const user = userEvent.setup()
    approveConsent.mockResolvedValue('https://voc.auth.us-east-1.amazoncognito.com/oauth2/authorize?x=1')
    renderConsent()

    await user.click(await screen.findByRole('radio', { name: /Read and write/ }))
    await user.selectOptions(screen.getByRole('combobox'), await screen.findByRole('option', { name: 'Checkout revamp' }))
    await user.click(screen.getByRole('button', { name: 'Approve and sign in' }))

    expect(approveConsent).toHaveBeenCalledWith({ authorize_query: QUERY, scope: 'write', project_id: 'proj_1' })
    expect(assign).toHaveBeenCalledWith('https://voc.auth.us-east-1.amazoncognito.com/oauth2/authorize?x=1')
  })

  it('says the sign-in acts outside any workspace when none is open', async () => {
    renderConsent()

    expect(await screen.findByText(/outside any workspace/)).toBeInTheDocument()
  })

  it('names the workspace the sign-in will act in', async () => {
    setCurrentWorkspace({ id: 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', slug: 'acme', name: 'Acme Outfitters', role: 'editor' })
    renderConsent()

    expect(await screen.findByText('This sign-in will act in the Acme Outfitters workspace only.')).toBeInTheDocument()
  })

  it('tells a non-member to add themselves first on the 403, not to try again', async () => {
    const user = userEvent.setup()
    approveConsent.mockRejectedValue(new ApiError(403, 'Only a member of an existing workspace can approve a sign-in'))
    setCurrentWorkspace({ id: 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8', slug: 'acme', name: 'Acme Outfitters', role: 'admin' })
    renderConsent()

    await user.click(await screen.findByRole('button', { name: 'Approve and sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(/add yourself as a member first/)
    expect(assign).not.toHaveBeenCalled()
  })

  it('offers to try again when the approval fails otherwise', async () => {
    const user = userEvent.setup()
    approveConsent.mockRejectedValue(new ApiError(500))
    renderConsent()

    await user.click(await screen.findByRole('button', { name: 'Approve and sign in' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('The approval failed. Try again.')
  })

  it('offers read only when the client asked for no more', async () => {
    describeConsent.mockResolvedValue({ ...DESCRIBED, can_write: false })
    renderConsent()

    await screen.findByText('Kiro asks to use VoC as you.')
    expect(screen.queryByRole('radio', { name: /Read and write/ })).not.toBeInTheDocument()
  })

  it('denies back to the assistant without approving', async () => {
    const user = userEvent.setup()
    renderConsent()

    await user.click(await screen.findByRole('button', { name: 'Deny' }))

    expect(assign).toHaveBeenCalledWith(DESCRIBED.deny_redirect)
    expect(approveConsent).not.toHaveBeenCalled()
  })

  it('explains a refused request and offers the way back', async () => {
    describeConsent.mockResolvedValue({ refused: true, error: 'invalid_request', error_description: 'PKCE is required',
      redirect_to: 'http://127.0.0.1:53111/oauth/callback?error=invalid_request' })
    renderConsent()

    expect(await screen.findByText(/cannot be approved: PKCE is required/)).toBeInTheDocument()
  })

  it('refuses a page opened without a request', () => {
    renderConsent('')

    expect(screen.getByRole('alert')).toHaveTextContent(/not valid/)
    expect(describeConsent).not.toHaveBeenCalled()
  })
})
