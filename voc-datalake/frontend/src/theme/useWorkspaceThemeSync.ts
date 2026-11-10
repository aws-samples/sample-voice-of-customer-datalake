/**
 * @fileoverview Keeps the cached workspace theme (themeStore `workspaceTheme`) in
 * step with the administrator's pick, `GET /settings/appearance`.
 *
 * Mounted once inside the signed-in shell (WorkspaceThemeSync in routes.tsx). The
 * cache lets the next page load paint the workspace theme before any request
 * (public/theme-init.js). A failed read keeps the cached value and shows nothing:
 * the app is fully usable in the theme it already has.
 *
 * @module theme/useWorkspaceThemeSync
 */
import { useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { appearanceApi, appearanceKey } from '../api/appearanceApi'
import { useConfigStore } from '../store/configStore'
import { useThemeStore } from './themeStore'

export function useWorkspaceThemeSync(): void {
  const apiEndpoint = useConfigStore((s) => s.config.apiEndpoint)
  const workspaceTheme = useThemeStore((s) => s.workspaceTheme)
  const setWorkspaceTheme = useThemeStore((s) => s.setWorkspaceTheme)
  const { data } = useQuery({
    queryKey: appearanceKey(),
    queryFn: () => appearanceApi.get(),
    enabled: apiEndpoint !== '',
  })
  const serverTheme = data?.default_theme
  useEffect(() => {
    if (serverTheme !== undefined && serverTheme !== workspaceTheme) setWorkspaceTheme(serverTheme)
  }, [serverTheme, workspaceTheme, setWorkspaceTheme])
}
