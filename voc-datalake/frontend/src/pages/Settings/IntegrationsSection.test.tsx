/**
 * Administration → Integrations: Figma / GitHub tokens are write-only (moved
 * here from the Company design-system tab, todofeatures §6.1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
vi.mock('../../api/client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))

const { default: IntegrationsSection } = await import('./IntegrationsSection')

const DESIGN = {
  tokens: { colors: [], typography: [], spacing: [], radius: [] },
  guidelines: '',
  references: [],
  integrations: { figma: true, github: false },
}

beforeEach(() => { fetchApi.mockReset() })

describe('IntegrationsSection', () => {
  it('shows configured state only, sends a typed token once and clears the field', async () => {
    const saveTokens = vi.fn((_body: unknown) => ({ integrations: { figma: true, github: true } }))
    fetchApi.mockImplementation((endpoint, options) => {
      if (options?.method === 'PUT' && endpoint === '/settings/design-system/integrations') {
        return Promise.resolve(saveTokens(JSON.parse(String(options.body))))
      }
      return Promise.resolve(DESIGN)
    })
    renderWithQueryClient(<TestRouter><IntegrationsSection /></TestRouter>)
    expect(await screen.findByLabelText(/figma token/i)).toHaveValue('')
    expect(screen.getByText('Configured')).toBeInTheDocument()
    const field = screen.getByLabelText(/github token/i)
    await userEvent.type(field, 'ghp_secret')
    await userEvent.click(screen.getByRole('button', { name: 'Save tokens' }))
    await waitFor(() => expect(saveTokens).toHaveBeenCalledWith({ github_token: 'ghp_secret' }))
    await waitFor(() => expect(field).toHaveValue(''))
  })

  it('points MCP access to Connect', async () => {
    fetchApi.mockResolvedValue(DESIGN)
    renderWithQueryClient(<TestRouter><IntegrationsSection /></TestRouter>)
    expect(await screen.findByRole('link', { name: 'Connect' })).toHaveAttribute('href', '/connect')
  })

  it('offers the setup help for both tokens on the tab', async () => {
    fetchApi.mockResolvedValue(DESIGN)
    renderWithQueryClient(<TestRouter><IntegrationsSection /></TestRouter>)
    expect(await screen.findByRole('button', { name: /figma personal access token/i })).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByRole('button', { name: /github fine-grained personal access token/i })).toHaveAttribute('aria-expanded', 'false')
  })
})
