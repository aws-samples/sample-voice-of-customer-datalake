/**
 * Administration → Brand & appearance (7.54.00, BrandPage.tsx): the brand saves from its own card (no page-level
 * Save) and says "Saved" until the next edit; read-only, the notice names who may change it (the deployment's
 * administrators outside a workspace, the workspace's admins inside one); the default theme is a platform admin's;
 * the API endpoint is a development build's alone, under Advanced, saved by its own button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { ACME } from '../../test/workspaceFixtures'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import { useConfigStore } from '../../store/configStore'

const api = {
  getBrandSettings: vi.fn<() => Promise<unknown>>(),
  saveBrandSettings: vi.fn<(payload: unknown) => Promise<unknown>>(),
}
vi.mock('../../api/client', () => ({ api }))
// The default-theme card has its own suite; here only who may edit it (a platform admin, not every admin).
vi.mock('./DefaultThemeCard', () => ({
  default: ({ canEdit }: { readonly canEdit: boolean }) => <p data-testid="default-theme-card">{canEdit ? 'editable' : 'read-only'}</p>,
}))

const { default: BrandPage } = await import('./BrandPage')

const API = 'https://api.example.com'

function renderPage({ isAdmin = true, isPlatformAdmin = false } = {}) {
  const onApiEndpointChange = vi.fn<(value: string) => void>()
  renderWithQueryClient(
    <TestRouter initialEntries={['/admin/brand']}>
      <BrandPage apiEndpoint={API} onApiEndpointChange={onApiEndpointChange} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />
    </TestRouter>,
  )
  return { onApiEndpointChange }
}

beforeEach(() => {
  useConfigStore.setState((state) => ({
    config: { ...state.config, apiEndpoint: API, brandName: '', brandHandles: [], hashtags: [], urlsToTrack: [] },
  }))
  api.getBrandSettings.mockResolvedValue({ brand_name: 'Acme Outfitters', brand_handles: ['@acme'], hashtags: [], urls_to_track: [] })
  api.saveBrandSettings.mockResolvedValue({ success: true })
})
afterEach(() => {
  setCurrentWorkspace(null)
  vi.unstubAllEnvs()
})

describe('the brand card', () => {
  it('saves from its own Save, then says "Saved" until the next edit', async () => {
    renderPage()
    const user = userEvent.setup()
    const name = await screen.findByDisplayValue('Acme Outfitters')
    await user.type(name, ' Ltd')
    await user.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => { expect(api.saveBrandSettings).toHaveBeenCalledWith(expect.objectContaining({ brand_name: 'Acme Outfitters Ltd' })) })
    expect(await screen.findByText('Saved')).toBeInTheDocument()
    await user.type(name, '.')
    expect(screen.queryByText('Saved')).not.toBeInTheDocument()
  })

  it("names the deployment's administrators outside a workspace when read-only", async () => {
    renderPage({ isAdmin: false })
    expect(await screen.findByText('Only admins can change the brand configuration. You can view it here.')).toBeInTheDocument()
    expect(screen.getByLabelText('Brand Name')).toBeDisabled()
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument()
  })

  it("names the workspace's admins inside one", async () => {
    act(() => setCurrentWorkspace({ ...ACME, role: 'viewer' }))
    renderPage()
    expect(await screen.findByText("Only this workspace's admins can change its brand. You can view it here.")).toBeInTheDocument()
  })
})

describe('the default theme', () => {
  it.each([[true, 'editable'], [false, 'read-only']])('is a platform admin\'s (%s → %s)', (isPlatformAdmin, shown) => {
    renderPage({ isPlatformAdmin })
    expect(screen.getByTestId('default-theme-card')).toHaveTextContent(shown)
  })
})

describe('the API endpoint, under Advanced', () => {
  it('is a development build\'s alone: a production build offers no control that can originate an endpoint', () => {
    vi.stubEnv('DEV', false)
    renderPage()
    expect({
      advanced: screen.queryByRole('button', { name: 'Advanced' }),
      endpointInput: screen.queryByPlaceholderText(/your-api-id.execute-api/i),
      anyUrlInput: document.querySelector('input[type="url"]'),
    }).toStrictEqual({ advanced: null, endpointInput: null, anyUrlInput: null })
  })

  it('saves the endpoint from its own button in development', async () => {
    vi.stubEnv('DEV', true)
    renderPage()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Advanced' }))
    expect(screen.getByText('API Configuration')).toBeInTheDocument()
    await user.click(screen.getAllByRole('button', { name: /save changes/i }).at(-1) ?? document.body)
    expect(useConfigStore.getState().config.apiEndpoint).toBe(API)
  })
})
