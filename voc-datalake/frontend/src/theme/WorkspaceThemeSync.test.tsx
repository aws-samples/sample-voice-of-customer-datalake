/**
 * The mount the signed-in shell renders: it draws nothing and caches the administrator's
 * start theme (the sync itself is pinned by useWorkspaceThemeSync.test.tsx).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

vi.mock('../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { renderWithQueryClient } from '@test/query-client'
import { useThemeStore } from './themeStore'
import WorkspaceThemeSync from './WorkspaceThemeSync'

beforeEach(() => {
  resetFetchApi()
  useThemeStore.setState({ workspaceTheme: 'kiro', colorTheme: 'workspace' })
})

describe('WorkspaceThemeSync', () => {
  it('renders nothing and caches the administrator’s start theme', async () => {
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: 'quick' }) })
    const { container } = renderWithQueryClient(<WorkspaceThemeSync />)
    expect(container).toBeEmptyDOMElement()
    await waitFor(() => expect(useThemeStore.getState().workspaceTheme).toBe('quick'))
  })
})
