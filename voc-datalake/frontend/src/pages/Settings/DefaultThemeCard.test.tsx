/**
 * Administration → General → Default theme: an admin picks and saves (the cached workspace
 * theme follows); a non-admin sees it read-only; a failed save or read is shown.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { z } from 'zod'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { renderWithQueryClient } from '@test/query-client'
import { useThemeStore } from '../../theme/themeStore'
import DefaultThemeCard from './DefaultThemeCard'

const API = 'https://api.example.com'
const PutBody = z.object({ default_theme: z.string() })

/** A stateful GET/PUT pair like the mock server's; `putOk: false` = every PUT is a 500. */
function serve(initial: string, putOk = true) {
  const stored = { theme: initial }
  routeFetchApi({
    'GET /settings/appearance': () => ({ default_theme: stored.theme }),
    'PUT /settings/appearance': (body) => {
      if (!putOk) throw new Error('API Error: 500')
      stored.theme = PutBody.parse(body).default_theme
      return { success: true, settings: { default_theme: stored.theme } }
    },
  })
  return stored
}

const radio = (name: string) => screen.getByRole('radio', { name })
const saveButton = () => screen.getByRole('button', { name: 'Save theme' })

async function pickAndSave(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole('radio', { name }))
  await user.click(saveButton())
}

beforeEach(() => {
  resetFetchApi()
  useThemeStore.setState({ workspaceTheme: 'kiro', colorTheme: 'workspace' })
})

describe('DefaultThemeCard — admin', () => {
  it('enables Save only once the pick differs from the saved theme', async () => {
    serve('kiro')
    renderWithQueryClient(<DefaultThemeCard apiEndpoint={API} isAdmin />)
    expect(await screen.findByRole('button', { name: 'Save theme' })).toBeDisabled()
    await userEvent.click(radio('Nord'))
    expect(saveButton()).toBeEnabled()
  })

  it('saves the pick; the cached workspace theme follows', async () => {
    const stored = serve('kiro')
    renderWithQueryClient(<DefaultThemeCard apiEndpoint={API} isAdmin />)
    await pickAndSave(userEvent.setup(), 'Nord')
    await waitFor(() => expect(useThemeStore.getState().workspaceTheme).toBe('nord'))
    expect(stored.theme).toBe('nord')
    expect(radio('Nord')).toHaveAttribute('aria-checked', 'true')
    expect(saveButton()).toBeDisabled()
  })

  it('shows a failed save and keeps the pick', async () => {
    serve('kiro', false)
    renderWithQueryClient(<DefaultThemeCard apiEndpoint={API} isAdmin />)
    await pickAndSave(userEvent.setup(), 'High contrast')
    expect(await screen.findByText('Couldn’t save the default theme. Try again.')).toBeInTheDocument()
    expect(radio('High contrast')).toHaveAttribute('aria-checked', 'true')
    expect(useThemeStore.getState().workspaceTheme).toBe('kiro')
  })

  it('shows a failed read', async () => {
    routeFetchApi({}, { missStatus: 500 })
    renderWithQueryClient(<DefaultThemeCard apiEndpoint={API} isAdmin />)
    expect(await screen.findByText('Couldn’t load the default theme from the server.')).toBeInTheDocument()
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument()
  })
})

describe('DefaultThemeCard — non-admin', () => {
  it('shows the current theme read-only, with the admin-only notice and no Save', async () => {
    serve('dracula')
    renderWithQueryClient(<DefaultThemeCard apiEndpoint={API} isAdmin={false} />)
    expect(await screen.findByRole('radio', { name: 'Dracula' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByText('Only admins can change the default theme. You can view it here.')).toBeInTheDocument()
    expect(screen.getByRole('radiogroup')).toHaveAttribute('aria-readonly', 'true')
    expect(screen.queryByRole('button', { name: 'Save theme' })).not.toBeInTheDocument()
  })

  it('cannot change the pick, and nothing is sent', async () => {
    serve('dracula')
    renderWithQueryClient(<DefaultThemeCard apiEndpoint={API} isAdmin={false} />)
    await userEvent.click(await screen.findByRole('radio', { name: 'Quick' }))
    expect(radio('Dracula')).toHaveAttribute('aria-checked', 'true')
    expect(fetchApi).toHaveBeenCalledExactlyOnceWith('/settings/appearance', undefined)
  })
})
