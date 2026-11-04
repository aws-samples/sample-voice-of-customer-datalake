/**
 * @fileoverview Administration → General → Default theme under the shared unsaved-changes
 * guard, in a DATA router (`useBlocker` live), through the shared contract (3.00.00 R2):
 * an unsaved pick asks before the page is left, Cancel keeps it even when the stored theme
 * refetches while the dialog is open, and Discard lets the leave through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { mountAtAdmin } from '@test/adminRoute'
import { expectCancelKeepsDraftGuarded } from '@test/unsavedGuardContract'
import type { GuardUser } from '@test/unsavedGuardContract'
import { appearanceKey } from '../../api/appearanceApi'
import { useThemeStore } from '../../theme/themeStore'
import DefaultThemeCard from './DefaultThemeCard'

const API = 'https://api.example.com'

const mountAdmin = (isAdmin = true) => mountAtAdmin(<DefaultThemeCard apiEndpoint={API} isAdmin={isAdmin} />)

beforeEach(() => {
  resetFetchApi()
  useThemeStore.setState({ workspaceTheme: 'kiro', colorTheme: 'workspace' })
})

describe('Default theme — Cancel keeps the pick and stays guarded (R2)', () => {
  it('when the stored theme refetches while the dialog is open', async () => {
    const server = { theme: 'kiro' }
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: server.theme }) })
    const mounted: { current?: ReturnType<typeof mountAdmin> } = {}
    const router = () => {
      if (mounted.current === undefined) throw new Error('not mounted')
      return mounted.current.router
    }
    await expectCancelKeepsDraftGuarded({
      mount: async () => {
        mounted.current = mountAdmin()
        await screen.findByRole('radio', { name: 'Kiro' })
      },
      edit: async (user: GuardUser) => { await user.click(screen.getByRole('radio', { name: 'Nord' })) },
      expectDraft: () => expect(screen.getByRole('radio', { name: 'Nord' })).toHaveAttribute('aria-checked', 'true'),
      leave: async (user: GuardUser) => { await user.click(screen.getByRole('link', { name: 'Home' })) },
      expectStayed: () => expect(router().state.location.pathname).toBe('/admin'),
      expectLeft: async () => { expect(await screen.findByText('Home page')).toBeInTheDocument() },
      whileDialogOpen: async () => {
        // Another admin saved Dracula; the unsaved Nord pick must survive the refetch.
        server.theme = 'dracula'
        await mounted.current?.client.invalidateQueries({ queryKey: appearanceKey() })
      },
    })
  })

  it('does not guard a read-only viewer', async () => {
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: 'kiro' }) })
    mountAdmin(false)
    await screen.findByRole('radio', { name: 'Kiro' })
    await userEvent.click(screen.getByRole('radio', { name: 'Nord' }))
    await userEvent.click(screen.getByRole('link', { name: 'Home' }))
    expect(await screen.findByText('Home page')).toBeInTheDocument()
  })
})
