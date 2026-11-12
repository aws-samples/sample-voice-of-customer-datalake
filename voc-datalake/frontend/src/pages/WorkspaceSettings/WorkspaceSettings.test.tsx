/**
 * The workspace's settings page: not a page outside a workspace; the brand, which its admins save (also outside the
 * deployment's `admins`) and everyone else reads, a refusal said in words; the plugins the deployment offers, with
 * Enable and Disable for an admin only, an enable the server holds back said as such and offered no more.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { TestRouter } from '../../test/TestRouter'
import { ACME, JUNIPER } from '../../test/workspaceFixtures'

// The page reads the brand through `api` and the plugins through `fetchApi`: both answer from the routed double.
vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => ({
  ...m.fetchApiClientModule(),
  api: {
    getBrandSettings: () => m.fetchApi('/settings/brand'),
    saveBrandSettings: (settings: unknown) => m.fetchApi('/settings/brand', { method: 'PUT', body: JSON.stringify(settings) }),
  },
})))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { useAuthStore } from '../../store/authStore'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import type { CurrentWorkspace } from '../../workspace/currentWorkspace'
import { INGESTION_NOT_YET } from '../../workspace/workspaceRefusals'
import WorkspaceSettings from './WorkspaceSettings'

const PLUGINS = '/me/workspaces/current/plugins'
const BRAND = { brand_name: 'Acme Outfitters', brand_handles: ['@acme'], hashtags: ['#trail'], urls_to_track: ['https://example.com/reviews'] }
const OFFERED = [{ id: 'webscraper', enabled: false }, { id: 'github_issues', enabled: true, enabled_at: '2026-11-01T09:00:00Z' }]

function renderPage(workspace: CurrentWorkspace | null, routes: Record<string, RouteHandler> = {}) {
  routeFetchApi({
    'GET /me/workspaces': () => ({ workspaces: [ACME, JUNIPER] }),
    'GET /me/workspaces/current': () => ({ workspace }),
    'GET /settings/brand': () => BRAND,
    [`GET ${PLUGINS}`]: () => ({ plugins: OFFERED }),
    ...routes,
  })
  act(() => setCurrentWorkspace(workspace))
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TestRouter initialEntries={['/workspace-settings']}><WorkspaceSettings /></TestRouter>
    </QueryClientProvider>,
  )
}

const brandName = () => screen.findByLabelText('Brand Name')

beforeEach(() => {
  resetFetchApi()
  // Not in the deployment's `admins`: inside a workspace only the workspace's role counts.
  useAuthStore.setState({ user: { username: 'ada', email: 'ada@example.com', groups: ['users'], sub: 'sub-ada' } })
})
afterEach(() => {
  setCurrentWorkspace(null)
  useAuthStore.setState({ user: null })
})

describe('WorkspaceSettings outside a workspace', () => {
  it('is not a page and reads nothing', async () => {
    renderPage(null)
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeInTheDocument()
    // Past every pending query and effect, so a late read would have been made by now.
    await act(async () => { await new Promise((resolve) => { setTimeout(resolve, 50) }) })
    expect(fetchApi).not.toHaveBeenCalledWith(PLUGINS)
  })
})

describe('WorkspaceSettings: the brand', () => {
  it('lets a workspace admin outside the deployment admins edit and save it', async () => {
    const saved = vi.fn<RouteHandler>((body) => ({ success: true, settings: body }))
    renderPage(ACME, { 'PUT /settings/brand': saved })
    await waitFor(async () => expect(await brandName()).toHaveValue('Acme Outfitters'))
    await userEvent.clear(await brandName())
    await userEvent.type(await brandName(), 'Acme Outfitters Trail Gear')
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Brand saved.')
    expect(saved).toHaveBeenCalledWith({ ...BRAND, brand_name: 'Acme Outfitters Trail Gear' })
  })

  it('shows it read-only to an editor, with who may change it and no Save', async () => {
    renderPage(JUNIPER)
    await waitFor(async () => expect(await brandName()).toHaveValue('Acme Outfitters'))
    expect(await brandName()).toBeDisabled()
    expect(screen.getByText("Only this workspace's admins can change its brand. You can view it here.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument()
  })

  it('takes the role the server applies over the membership row', async () => {
    renderPage(JUNIPER, { 'GET /me/workspaces/current': () => ({ workspace: { ...JUNIPER, role: 'admin' } }) })
    expect(await screen.findByRole('button', { name: 'Save Changes' })).toBeEnabled()
  })

  it("says the server's 403 in words: only the workspace's admins change its brand", async () => {
    renderPage(ACME, { 'PUT /settings/brand': () => { throw new ApiError(403, 'Workspace admin access required') } })
    await userEvent.click(await screen.findByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Only this workspace's admins can change its brand.")
  })
})

describe('WorkspaceSettings: the plugins', () => {
  it('lists every plugin the deployment offers by name, with whether the workspace turned it on', async () => {
    renderPage(JUNIPER)
    const list = await screen.findByRole('list', { name: 'Plugins this deployment offers' })
    expect(list).toHaveTextContent(/Web Scraper\s*Off/)
    expect(list).toHaveTextContent(/GitHub Issues\s*On/)
    expect(screen.getByText("Only this workspace's admins can turn plugins on or off.")).toBeInTheDocument()
  })

  it('offers an editor no Enable or Disable', async () => {
    renderPage(JUNIPER)
    await screen.findByRole('list', { name: 'Plugins this deployment offers' })
    expect(screen.queryByRole('button', { name: /^(Enable|Disable) / })).not.toBeInTheDocument()
  })

  it('says why an enable is held back, and keeps Enable focusable, described by the reason', async () => {
    const change = vi.fn<RouteHandler>(() => { throw new ApiError(409, INGESTION_NOT_YET) })
    renderPage(ACME, { [`PUT ${PLUGINS}/webscraper`]: change })
    await userEvent.click(await screen.findByRole('button', { name: 'Enable Web Scraper for this workspace' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Per-workspace ingestion arrives with a later release: a workspace cannot enable a plugin yet.')
    const enable = screen.getByRole('button', { name: 'Enable Web Scraper for this workspace' })
    expect(enable).toHaveAttribute('aria-disabled', 'true')
    enable.focus()
    expect(enable).toHaveFocus()
    expect(enable).toHaveAccessibleDescription('Per-workspace ingestion arrives with a later release: a workspace cannot enable a plugin yet.')
  })

  it('sends nothing when a held Enable is pressed again', async () => {
    const change = vi.fn<RouteHandler>(() => { throw new ApiError(409, INGESTION_NOT_YET) })
    renderPage(ACME, { [`PUT ${PLUGINS}/webscraper`]: change })
    await userEvent.click(await screen.findByRole('button', { name: 'Enable Web Scraper for this workspace' }))
    await screen.findByRole('status')
    await userEvent.click(screen.getByRole('button', { name: 'Enable Web Scraper for this workspace' }))
    await userEvent.keyboard('{Enter}')
    expect(change).toHaveBeenCalledTimes(1)
  })

  it('disables an enabled plugin and reads the list back', async () => {
    const server = { plugins: OFFERED }
    const change = vi.fn<RouteHandler>(() => {
      server.plugins = OFFERED.map((plugin) => ({ id: plugin.id, enabled: false }))
      return { plugin: { id: 'github_issues', enabled: false } }
    })
    renderPage(ACME, { [`GET ${PLUGINS}`]: () => server, [`PUT ${PLUGINS}/github_issues`]: change })
    await userEvent.click(await screen.findByRole('button', { name: 'Disable GitHub Issues for this workspace' }))
    expect(await screen.findByRole('button', { name: 'Enable GitHub Issues for this workspace' })).toBeEnabled()
    expect(change).toHaveBeenCalledWith({ enabled: false })
  })

  it('says any other refusal in words, and keeps Enable offered', async () => {
    renderPage(ACME, { [`PUT ${PLUGINS}/webscraper`]: () => { throw new ApiError(403, 'You are no longer an admin of this workspace') } })
    await userEvent.click(await screen.findByRole('button', { name: 'Enable Web Scraper for this workspace' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('You are no longer an admin of this workspace. Reload the page.')
    expect(screen.getByRole('button', { name: 'Enable Web Scraper for this workspace' })).toBeEnabled()
  })

  it('offers Try again when the list cannot be read', async () => {
    const list = vi.fn<RouteHandler>(() => { throw new ApiError(500) })
    renderPage(ACME, { [`GET ${PLUGINS}`]: list })
    expect(await screen.findByRole('alert', {}, { timeout: 3000 })).toHaveTextContent('The plugins could not be loaded.')
    list.mockImplementation(() => ({ plugins: OFFERED }))
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(await screen.findByRole('list', { name: 'Plugins this deployment offers' })).toBeInTheDocument()
  })
})
