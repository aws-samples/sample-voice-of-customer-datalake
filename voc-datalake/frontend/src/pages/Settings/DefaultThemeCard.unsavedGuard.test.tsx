/**
 * @fileoverview Administration → General → Default theme under the shared unsaved-changes
 * guard, in a DATA router (`useBlocker` live), through the shared contract (3.00.00 R2):
 * an unsaved pick asks before the page is left, Cancel keeps it even when the stored theme
 * refetches while the dialog is open, and Discard lets the leave through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { adminGuardScenario, mountAtAdmin } from '@test/adminRoute'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import type { GuardUser } from '@test/unsavedGuardContract'
import { appearanceKey } from '../../api/appearanceApi'
import { useThemeStore } from '../../theme/themeStore'
import DefaultThemeCard from './DefaultThemeCard'

const API = 'https://api.example.com'

beforeEach(() => {
  resetFetchApi()
  useThemeStore.setState({ workspaceTheme: 'kiro', colorTheme: 'workspace' })
})

describe('Default theme — Cancel keeps the pick and stays guarded (R2)', () => {
  it('when the stored theme refetches while the dialog is open', async () => {
    const server = { theme: 'kiro' }
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: server.theme }) })
    const { scenario } = adminGuardScenario({
      page: () => <DefaultThemeCard apiEndpoint={API} isAdmin />,
      ready: async () => { await screen.findByRole('radio', { name: 'Kiro' }) },
      edit: async (user: GuardUser) => { await user.click(screen.getByRole('radio', { name: 'Nord' })) },
      expectDraft: () => expect(screen.getByRole('radio', { name: 'Nord' })).toHaveAttribute('aria-checked', 'true'),
      whileDialogOpen: async ({ client }) => {
        // Another admin saved Dracula; the unsaved Nord pick must survive the refetch.
        server.theme = 'dracula'
        await client.invalidateQueries({ queryKey: appearanceKey() })
      },
    })
    await expectCancelKeepsDraftGuarded(scenario)
  })

  // Only what can unmount the card asks: an overlay such as the review modal (?review=) keeps it.
  it('lets a ?review= overlay through with a pick unsaved, but asks before a tab switch', async () => {
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: 'kiro' }) })
    const { router } = mountAtAdmin(<DefaultThemeCard apiEndpoint={API} isAdmin />)
    await userEvent.click(await screen.findByRole('radio', { name: 'Nord' }))
    await act(() => router.navigate('/admin?review=fb_1'))
    expect([router.state.location.search, screen.queryByRole('dialog')]).toStrictEqual(['?review=fb_1', null])
    await act(() => router.navigate('/admin?tab=sources'))
    expect(await screen.findByRole('dialog', { name: 'Unsaved changes' })).toBeInTheDocument()
  })

  it('does not guard a read-only viewer', async () => {
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: 'kiro' }) })
    mountAtAdmin(<DefaultThemeCard apiEndpoint={API} isAdmin={false} />)
    await screen.findByRole('radio', { name: 'Kiro' })
    await userEvent.click(screen.getByRole('radio', { name: 'Nord' }))
    await userEvent.click(screen.getByRole('link', { name: 'Home' }))
    expect(await screen.findByText('Home page')).toBeInTheDocument()
  })
})
