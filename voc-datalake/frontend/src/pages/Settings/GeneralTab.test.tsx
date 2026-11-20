/**
 * Administration → General (7.59.00, GeneralTab.tsx; 7.54.00's Brand & appearance): the brand saves from its own card
 * (no page-level Save) and says "Saved" until the next edit; read-only, the notice names who may change it (the
 * deployment's administrators outside a workspace, the workspace's admins inside one); the card says where the form
 * brand is set; the default theme is a platform admin's; the API endpoint is a development build's alone, under
 * Advanced, saved by its own button; each card is an anchor a link may name.
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

const { default: GeneralTab } = await import('./GeneralTab')

const API = 'https://api.example.com'

function renderPage({ isAdmin = true, isPlatformAdmin = false } = {}) {
  const onApiEndpointChange = vi.fn<(value: string) => void>()
  renderWithQueryClient(
    <TestRouter initialEntries={['/admin/general']}>
      <GeneralTab apiEndpoint={API} onApiEndpointChange={onApiEndpointChange} isAdmin={isAdmin} isPlatformAdmin={isPlatformAdmin} />
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

describe('the brand card\'s save row', () => {
  it('is a registered action bar in the flow after the fields, never sticky over them (7.59.00)', async () => {
    renderPage()
    const row = (await screen.findByRole('button', { name: /save changes/i })).closest('[data-action-bar]')
    const urls = screen.getByLabelText('URLs to Track (one per line)')
    const after = row === null ? 0 : row.compareDocumentPosition(urls) & Node.DOCUMENT_POSITION_PRECEDING
    expect([row === null, row?.classList.contains('sticky'), after > 0]).toStrictEqual([false, false, true])
  })
})

describe('the form brand', () => {
  it('says the form brand is set from a form\'s Style panel, with the way to Feedback forms', async () => {
    renderPage()
    expect(await screen.findByRole('link', { name: 'Feedback forms' })).toHaveAttribute('href', '/feedback-forms')
    expect(screen.getByText(/New feedback forms start on your form brand/)).toBeInTheDocument()
  })
})

describe('the cards a link names', () => {
  it('anchors the brand and the default theme (#brand, #theme)', () => {
    renderPage()
    expect([document.getElementById('admin-card-brand'), document.getElementById('admin-card-theme')].map((card) => card?.tabIndex))
      .toStrictEqual([-1, -1])
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
