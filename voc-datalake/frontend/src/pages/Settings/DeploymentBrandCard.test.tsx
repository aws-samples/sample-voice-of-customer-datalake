/**
 * The platform console's editor of the deployment's default brand: it reads and saves `/settings/brand` as a
 * deployment-wide request (no `X-Workspace-Id`, even inside a workspace), offers Save to the deployment's `admins`
 * (the gate the server applies without a workspace), and says a 403 in words. The console shows it below the
 * workspaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { TestRouter } from '../../test/TestRouter'
import { ACME } from '../../test/workspaceFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
// `useIsAdmin` answers the test's flag (a DEV build without Cognito would always answer admin).
vi.mock('../../store/authStore', async (importOriginal) => {
  const { adminFlag } = await import('@test/fetchApiRoutes')
  return { ...await importOriginal<typeof import('../../store/authStore')>(), useIsAdmin: () => adminFlag.isAdmin }
})

import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { setCurrentWorkspace } from '../../workspace/currentWorkspace'
import AdminSectionContent from './AdminSectionContent'
import DeploymentBrandCard from './DeploymentBrandCard'

const DEPLOYMENT_BRAND = { brand_name: 'Juniper Trail Co.', brand_handles: [], hashtags: [], urls_to_track: [] }

function renderCard(routes: Record<string, RouteHandler> = {}) {
  routeFetchApi({ 'GET /settings/brand': () => DEPLOYMENT_BRAND, ...routes })
  return render(
    <QueryClientProvider client={createTestQueryClient()}>
      <TestRouter initialEntries={['/admin']}><DeploymentBrandCard /></TestRouter>
    </QueryClientProvider>,
  )
}

const brandName = () => screen.findByLabelText('Brand Name')

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  // Inside a workspace: the one place the opt-out matters.
  act(() => setCurrentWorkspace(ACME))
})
afterEach(() => {
  setCurrentWorkspace(null)
  adminFlag.isAdmin = true
})

describe('DeploymentBrandCard', () => {
  it('reads the deployment-wide brand, never the workspace\'s', async () => {
    renderCard()
    await waitFor(async () => expect(await brandName()).toHaveValue('Juniper Trail Co.'))
    expect(fetchApi).toHaveBeenCalledWith('/settings/brand', { method: 'GET' }, 'deployment')
  })

  it('saves it as a deployment-wide request', async () => {
    const saved = vi.fn<RouteHandler>(() => ({ success: true }))
    renderCard({ 'PUT /settings/brand': saved })
    await waitFor(async () => expect(await brandName()).toHaveValue('Juniper Trail Co.'))
    await userEvent.type(await brandName(), ' Outfitters')
    await userEvent.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByRole('status')).toHaveTextContent('Brand saved.')
    expect(saved).toHaveBeenCalledWith({ ...DEPLOYMENT_BRAND, brand_name: 'Juniper Trail Co. Outfitters' })
    expect(fetchApi).toHaveBeenCalledWith('/settings/brand', expect.objectContaining({ method: 'PUT' }), 'deployment')
  })

  it("says the server's 403 in words", async () => {
    renderCard({ 'PUT /settings/brand': () => { throw new ApiError(403, 'Admin access required') } })
    await userEvent.click(await screen.findByRole('button', { name: 'Save Changes' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("Only the deployment's administrators can change the default brand.")
  })

  it('is read-only for someone outside the deployment admins, as the server decides', async () => {
    adminFlag.isAdmin = false
    renderCard()
    expect(await brandName()).toBeDisabled()
    expect(screen.getByText("Only the deployment's administrators can change the default brand. You can view it here.")).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Save Changes' })).not.toBeInTheDocument()
  })

  it('sits in the platform console below the workspaces', async () => {
    routeFetchApi({ 'GET /settings/brand': () => DEPLOYMENT_BRAND, 'GET /platform/workspaces': () => ({ workspaces: [], next_cursor: null }) })
    render(
      <QueryClientProvider client={createTestQueryClient()}>
        <TestRouter initialEntries={['/admin']}>
          <AdminSectionContent tab="access" section="workspaces" apiEndpoint="https://api.example.com" isAdmin isPlatformAdmin />
        </TestRouter>
      </QueryClientProvider>,
    )
    const headings = await screen.findAllByRole('heading', { level: 2 })
    expect(headings.map((heading) => heading.textContent)).toStrictEqual(['Workspaces', 'Deployment default brand'])
  })
})
