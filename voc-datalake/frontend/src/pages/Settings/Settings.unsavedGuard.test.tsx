/**
 * @fileoverview /admin brand edits under the shared unsaved-changes guard, in a
 * DATA router (`useBlocker` live), through the shared contract (3.00.00 R2):
 * Cancel keeps the brand draft and the next leave is guarded again, even when
 * the brand settings land — first load or refetch — while the dialog is open.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import type { GuardUser } from '@test/unsavedGuardContract'
import { useConfigStore } from '../../store/configStore'
import { brandSettingsKey } from '../../hooks/useBrandSettings'
import type { BrandSettingsResponse } from './useSettingsSync'

const getBrandSettings = vi.fn<() => Promise<BrandSettingsResponse>>()

vi.mock('../../api/client', () => ({
  api: {
    getBrandSettings: () => getBrandSettings(),
    saveBrandSettings: () => Promise.resolve({ success: true }),
  },
}))
vi.mock('../../store/authStore', () => ({ useIsAdmin: () => true }))
vi.mock('./LogsSection', () => ({ default: () => <p>Logs</p> }))

const { default: Settings } = await import('./Settings')

const stored = (brandName: string, hashtags: string[] = ['#stored']): BrandSettingsResponse => ({
  brand_name: brandName, brand_handles: ['@stored'], hashtags, urls_to_track: [],
})

function mountAdmin() {
  const client = createTestQueryClient()
  const router = createMemoryRouter(
    [
      { path: '/', element: <p>Home page</p> },
      { path: '/admin', element: <><Link to="/">Home</Link><Settings /></> },
    ],
    { initialEntries: ['/admin'] },
  )
  renderWithQueryClient(<RouterProvider router={router} />, client)
  return { client, router }
}

const brandField = () => screen.getByLabelText('Brand Name')

/** The shared scenario for the brand form; `whileDialogOpen` is what lands during the dialog. */
function brandScenario(whileDialogOpen: () => Promise<void>, ready: () => Promise<void>) {
  const mounted: { current?: ReturnType<typeof mountAdmin> } = {}
  const router = () => {
    if (mounted.current === undefined) throw new Error('not mounted')
    return mounted.current.router
  }
  return {
    mounted,
    scenario: {
      mount: async () => {
        mounted.current = mountAdmin()
        await ready()
      },
      edit: async (user: GuardUser) => {
        await user.type(brandField(), ' e2e-unsaved')
      },
      expectDraft: () => expect(brandField()).toHaveDisplayValue(/e2e-unsaved/),
      leave: async (user: GuardUser) => {
        await user.click(screen.getByRole('link', { name: 'Home' }))
      },
      expectStayed: () => expect(router().state.location.pathname).toBe('/admin'),
      expectLeft: async () => { expect(await screen.findByText('Home page')).toBeInTheDocument() },
      whileDialogOpen,
    },
  }
}

beforeEach(() => {
  getBrandSettings.mockReset()
  useConfigStore.setState((s) => ({
    config: { ...s.config, apiEndpoint: 'https://api.example.com', brandName: '', brandHandles: [], hashtags: [], urlsToTrack: [] },
  }))
})

describe('/admin brand form — Cancel keeps the draft and stays guarded (R2)', () => {
  it('when the first brand load lands while the dialog is open', async () => {
    // The inputs are editable while the load is in flight; production typed before it landed.
    const load: { resolve?: (value: BrandSettingsResponse) => void } = {}
    getBrandSettings.mockImplementation(() => new Promise((resolve) => { load.resolve = resolve }))
    const { scenario } = brandScenario(
      async () => {
        load.resolve?.(stored('Stored brand'))
        await screen.findByText('Synced to backend')
      },
      async () => { await screen.findByLabelText('Brand Name') },
    )
    await expectCancelKeepsDraftGuarded(scenario)
  })

  it('when the server copy changes and refetches while the dialog is open', async () => {
    const server = { current: stored('Stored brand') }
    getBrandSettings.mockImplementation(() => Promise.resolve(server.current))
    const { scenario, mounted } = brandScenario(
      async () => {
        // Another admin changed the hashtags; the edited Brand Name must survive the refetch.
        server.current = stored('Stored brand', ['#theirs'])
        await mounted.current?.client.invalidateQueries({ queryKey: brandSettingsKey() })
        expect(await screen.findByDisplayValue('#theirs')).toBeInTheDocument()
      },
      async () => { expect(await screen.findByDisplayValue('Stored brand')).toBeInTheDocument() },
    )
    await expectCancelKeepsDraftGuarded(scenario)
  })
})

describe('/admin brand form — in-page tab switches are URL changes, not leaves', () => {
  it('switches tab (pushing ?tab=) without the dialog and keeps the draft for Back', async () => {
    getBrandSettings.mockResolvedValue(stored('Stored brand'))
    const { router } = mountAdmin()
    const user = userEvent.setup()
    await user.type(await screen.findByLabelText('Brand Name'), ' draft')
    await user.click(screen.getByRole('button', { name: 'System', pressed: false }))
    const switched = { search: router.state.location.search, dialog: screen.queryByRole('dialog') }
    await act(() => router.navigate(-1))

    expect(switched).toStrictEqual({ search: '?tab=system&section=logs', dialog: null })
    expect(router.state.location.search).toBe('')
    expect(brandField()).toHaveDisplayValue(/draft$/)
  })
})
