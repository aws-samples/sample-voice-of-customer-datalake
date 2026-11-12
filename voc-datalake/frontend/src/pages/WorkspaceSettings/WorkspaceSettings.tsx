/**
 * @fileoverview The current workspace's settings, at `/workspace-settings` inside it (`/w/{slug}/workspace-settings`;
 * docs/multi-workspace.md → Per-workspace configuration), opened from the header's workspace menu beside Members.
 *
 * - The workspace's brand (`GET` and `PUT /settings/brand` with the workspace's `X-Workspace-Id`): every member reads
 *   it; its admins (the role the server applies here, `/current`) change it, whether or not they are in the
 *   deployment's `admins` group, which grants nothing inside a workspace.
 * - The workspace's plugins (`GET /me/workspaces/current/plugins`): every plugin the deployment offers, and whether
 *   this workspace turned it on; its admins turn one on or off (WorkspacePluginsCard.tsx: enabling is held).
 *
 * The deployment's own sections of Administration stay there, for the deployment's `admins`: this page holds only
 * what the server keys by workspace. The server decides every save; the page only hides what the caller's role
 * cannot do, and shows the loading state until it knows that role. Outside a workspace the address is not a page
 * (the app's "Page not found"), and the header offers no link to it.
 *
 * @module pages/WorkspaceSettings
 */
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { PageTitle } from '../../components/PageTitle/PageTitle'
import PageLoader from '../../components/PageLoader/PageLoader'
import NotFound from '../../components/RouteErrorBoundary/NotFound'
import { brandSettingsKey, useBrandSettings } from '../../hooks/useBrandSettings'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import type { CurrentWorkspace } from '../../workspace/currentWorkspace'
import { useServerRole } from '../../workspace/useMyWorkspaces'
import { BRAND_REFUSALS } from '../../workspace/workspaceRefusals'
import BrandEditorCard from '../Settings/BrandEditorCard'
import { useBrandForm } from '../Settings/useSettingsSync'
import WorkspacePluginsCard from './WorkspacePluginsCard'

export default function WorkspaceSettings() {
  const current = useCurrentWorkspace()
  if (current === null) return <NotFound />
  return <WorkspaceSettingsFor workspace={current} />
}

function WorkspaceSettingsFor({ workspace }: Readonly<{ workspace: CurrentWorkspace }>) {
  const { t } = useTranslation()
  const role = useServerRole(workspace)
  if (role === null) return <PageLoader />
  const isAdmin = role === 'admin'
  return (
    <div className="max-w-4xl mx-auto min-w-0 w-full space-y-4 sm:space-y-6">
      <PageTitle title={t('workspaces.settings.title')} subtitle={t('workspaces.settings.subtitle', { name: workspace.name })} />
      <WorkspaceBrandCard isAdmin={isAdmin} />
      <WorkspacePluginsCard workspaceId={workspace.id} isAdmin={isAdmin} />
    </div>
  )
}

/** The workspace's brand, kept in the workspace's own browser record too (as Administration → General does). */
function WorkspaceBrandCard({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const { config, setConfig } = useConfigStore()
  const query = useBrandSettings(config.apiEndpoint)
  const draft = useBrandForm(config, setConfig, query.data)
  return (
    <BrandEditorCard
      title={t('workspaces.settings.brandTitle')}
      description={t('workspaces.settings.brandDescription')}
      idPrefix="workspace-brand"
      load={query}
      draft={draft}
      canEdit={isAdmin}
      readOnlyNotice={t('workspaces.settings.brandReadOnly')}
      save={(payload) => api.saveBrandSettings(payload)}
      onSaved={() => queryClient.invalidateQueries({ queryKey: brandSettingsKey() })}
      refusals={BRAND_REFUSALS}
    />
  )
}
