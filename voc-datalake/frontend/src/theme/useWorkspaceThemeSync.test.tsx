/**
 * The workspace-theme sync: the administrator's pick replaces the cached one; a failed
 * read keeps the cache; no API endpoint = no request.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'

vi.mock('../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { createQueryWrapper, renderWithQueryClient } from '@test/query-client'
import { useConfigStore } from '../store/configStore'
import { useThemeStore } from './themeStore'
import { useWorkspaceThemeSync } from './useWorkspaceThemeSync'
import WorkspaceThemeSync from './WorkspaceThemeSync'

beforeEach(() => {
  resetFetchApi()
  useThemeStore.setState({ workspaceTheme: 'kiro', colorTheme: 'workspace' })
})

describe('useWorkspaceThemeSync', () => {
  it('caches the administrator’s theme', async () => {
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: 'nord' }) })
    renderHook(() => useWorkspaceThemeSync(), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(useThemeStore.getState().workspaceTheme).toBe('nord'))
  })

  it('keeps the cached theme when the read fails', async () => {
    useThemeStore.setState({ workspaceTheme: 'dracula' })
    routeFetchApi({}, { missStatus: 500 })
    renderHook(() => useWorkspaceThemeSync(), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/settings/appearance', undefined))
    expect(useThemeStore.getState().workspaceTheme).toBe('dracula')
  })

  it('leaves the person’s own pick alone', async () => {
    useThemeStore.setState({ colorTheme: 'quick' })
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: 'nord' }) })
    renderHook(() => useWorkspaceThemeSync(), { wrapper: createQueryWrapper() })
    await waitFor(() => expect(useThemeStore.getState().workspaceTheme).toBe('nord'))
    expect(useThemeStore.getState().colorTheme).toBe('quick')
  })

  it('asks nothing without an API endpoint', () => {
    useConfigStore.setState((s) => ({ config: { ...s.config, apiEndpoint: '' } }))
    renderHook(() => useWorkspaceThemeSync(), { wrapper: createQueryWrapper() })
    expect(fetchApi).not.toHaveBeenCalled()
  })
})

describe('WorkspaceThemeSync (the mount the signed-in shell renders)', () => {
  it('renders nothing and caches the administrator’s start theme', async () => {
    routeFetchApi({ 'GET /settings/appearance': () => ({ default_theme: 'quick' }) })
    const { container } = renderWithQueryClient(<WorkspaceThemeSync />)
    expect(container).toBeEmptyDOMElement()
    await waitFor(() => expect(useThemeStore.getState().workspaceTheme).toBe('quick'))
  })
})
