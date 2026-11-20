/**
 * @fileoverview /admin/general edits under the shared unsaved-changes guard, in a DATA router (`useBlocker` live),
 * through the shared contract (3.00.00 R2): Cancel keeps the brand draft and the next leave is guarded again, even
 * when the brand settings land — first load or refetch — while the dialog is open. The draft lives on General (7.59.00;
 * 7.54.00's Brand & appearance), in its BrandEditorCard (the card saves itself), so opening another tab asks too; a
 * card's hash (`#theme`) and an overlay (`?review=`) do not.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { adminGuardScenario, mountAtAdmin } from '@test/adminRoute'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import type { GuardUser } from '@test/unsavedGuardContract'
import { useConfigStore } from '../../store/configStore'
import { brandSettingsKey } from '../../hooks/useBrandSettings'
import type { BrandSettingsResponse } from '../../api/brandApi'

const getBrandSettings = vi.fn<() => Promise<BrandSettingsResponse>>()
const saveBrandSettings = vi.fn<(settings: unknown) => Promise<{ success: boolean }>>(() => Promise.resolve({ success: true }))

vi.mock('../../api/client', () => ({
  api: {
    getBrandSettings: () => getBrandSettings(),
    saveBrandSettings: (settings: unknown) => saveBrandSettings(settings),
    getUsers: () => Promise.resolve({ success: true, users: [] }),
    getSourcesStatus: () => Promise.resolve({ sources: {} }),
    getModelCapacity: () => Promise.resolve({ models: [], image: null }),
  },
}))
vi.mock('../../store/authStore', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../store/authStore')>(), useIsAdmin: () => true, useIsPlatformAdmin: () => false,
}))
vi.mock('./LogsSection', () => ({ default: () => <p>Logs</p> }))
vi.mock('./DefaultThemeCard', () => ({ default: () => null }))

const { default: Settings } = await import('./Settings')

const BRAND = '/admin/general'

const stored = (brandName: string, hashtags: string[] = ['#stored']): BrandSettingsResponse => ({
  brand_name: brandName, brand_handles: ['@stored'], hashtags, urls_to_track: [],
})

const brandField = () => screen.getByLabelText('Brand Name')

/** The shared scenario for the brand form; `whileDialogOpen` is what lands during the dialog. */
function brandScenario(whileDialogOpen: (mounted: ReturnType<typeof mountAtAdmin>) => Promise<void>, ready: () => Promise<void>) {
  return adminGuardScenario({
    page: () => <Settings />,
    path: BRAND,
    ready,
    edit: async (user: GuardUser) => { await user.type(brandField(), ' e2e-unsaved') },
    expectDraft: () => expect(brandField()).toHaveDisplayValue(/e2e-unsaved/),
    whileDialogOpen,
  })
}

beforeEach(() => {
  getBrandSettings.mockReset()
  useConfigStore.setState((s) => ({
    config: { ...s.config, apiEndpoint: 'https://api.example.com', brandName: '', brandHandles: [], hashtags: [], urlsToTrack: [] },
  }))
})

describe('/admin/general brand form — Cancel keeps the draft and stays guarded (R2)', () => {
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
    const { scenario } = brandScenario(
      async ({ client }) => {
        // Another admin changed the hashtags; the edited Brand Name must survive the refetch.
        server.current = stored('Stored brand', ['#theirs'])
        await client.invalidateQueries({ queryKey: brandSettingsKey() })
        expect(await screen.findByDisplayValue('#theirs')).toBeInTheDocument()
      },
      async () => { expect(await screen.findByDisplayValue('Stored brand')).toBeInTheDocument() },
    )
    await expectCancelKeepsDraftGuarded(scenario)
  })
})

/** Settings on the brand page, the stored brand loaded and " draft" typed after its name. */
async function draftTheBrandName() {
  getBrandSettings.mockResolvedValue(stored('Stored brand'))
  const { router } = mountAtAdmin(<Settings />, BRAND)
  const user = userEvent.setup()
  await user.type(await screen.findByLabelText('Brand Name'), ' draft')
  return { router, user }
}

describe('/admin/general brand form — the tab is the draft\'s page', () => {
  it('asks before another tab is opened, and Cancel keeps the draft on the brand page', async () => {
    const { router, user } = await draftTheBrandName()
    await user.click(screen.getByRole('tab', { name: 'System' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(screen.getByRole('button', { name: /cancel/i }))
    expect([dialog.isConnected, router.state.location.pathname]).toStrictEqual([false, BRAND])
    expect(brandField()).toHaveDisplayValue(/draft$/)
  })

  it('saves the draft from the dialog\'s Save, then opens the other tab', async () => {
    const { router, user } = await draftTheBrandName()
    await user.click(screen.getByRole('tab', { name: 'System' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Save' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe('/admin/system/logs') })
    expect(saveBrandSettings).toHaveBeenCalledWith(expect.objectContaining({ brand_name: 'Stored brand draft' }))
  })

  it('lets an overlay such as ?review= open without asking', async () => {
    const { router } = await draftTheBrandName()
    await act(() => router.navigate(`${BRAND}?review=fb_1`))
    expect([router.state.location.search, screen.queryByRole('dialog')]).toStrictEqual(['?review=fb_1', null])
  })

  it('lets a card of the tab be named (#theme) without asking', async () => {
    const { router } = await draftTheBrandName()
    await act(() => router.navigate(`${BRAND}#theme`))
    expect([router.state.location.hash, screen.queryByRole('dialog')]).toStrictEqual(['#theme', null])
    expect(brandField()).toHaveDisplayValue(/draft$/)
  })
})
