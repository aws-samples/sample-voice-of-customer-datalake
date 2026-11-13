/**
 * @fileoverview The current workspace's settings, at `/workspace-settings` inside it (`/w/{slug}/workspace-settings`;
 * docs/multi-workspace.md → Per-workspace configuration), opened from the header's workspace menu beside Members.
 *
 * - The workspace's brand (`GET` and `PUT /settings/brand` with the workspace's `X-Workspace-Id`): every member reads
 *   it; its admins (the role the server applies here, `/current`) change it, whether or not they are in the
 *   deployment's `admins` group, which grants nothing inside a workspace.
 * - The workspace's plugins (`GET /me/workspaces/current/plugins`): every plugin the deployment offers, and whether
 *   this workspace turned it on; its admins turn one on or off (WorkspacePluginsCard.tsx: enabling is held).
 * - The workspace's categories, dimensions and source policies (since 7.08.00): Administration's editors, with the
 *   workspace's `X-Workspace-Id`, for its admins (`WorkspaceConfigCards`); its other members see who changes them.
 *   Since 7.13.00 the categories card also holds the workspace's own "Reprocess existing feedback" (and the
 *   dimensions card its "Classify review types"): the workspace's own reprocess job, replaying its reviews only.
 * - The workspace's export (since 7.17.00, WorkspaceExportCard.tsx): its admins start one, follow it and download
 *   it for 7 days; its other members are told who can.
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
import { Info, Layers, ShieldCheck, Tags } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import CategoriesManager from '../../components/CategoriesManager/CategoriesManager'
import DimensionsManager from '../../components/DimensionsManager/DimensionsManager'
import Notice from '../../components/Notice/Notice'
import SourcesManager from '../../components/SourcesManager/SourcesManager'
import { SectionHeader } from '../Company/ContextParts'
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
import WorkspaceExportCard from './WorkspaceExportCard'
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
      <WorkspaceConfigCards isAdmin={isAdmin} />
      <WorkspaceExportCard workspaceId={workspace.id} isAdmin={isAdmin} />
    </div>
  )
}

function ConfigCard({ icon: Icon, title, description, children }: Readonly<{
  icon: LucideIcon; title: string; description: string; children: ReactNode
}>) {
  return (
    <section className="card" aria-label={title}>
      <SectionHeader icon={Icon} title={title} description={description} />
      {children}
    </section>
  )
}

/**
 * The workspace's own categories, dimensions and source policies (`/settings/categories`, `/dimensions` and
 * `/sources` with its `X-Workspace-Id`, since 7.08.00): the editors Administration uses, for its admins, without the
 * deployment's erasure panels. A new workspace has none of the three (nothing is copied from the deployment's), so
 * its feedback is classified with the built-in default categories and kept under the default source policy until
 * its admins save their own; each card says so. Its other members are told who changes them.
 */
function WorkspaceConfigCards({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation()
  if (!isAdmin) {
    return <Notice variant="banner" tone="warn" role="note" icon={Info} text={t('workspaces.config.readOnly')} />
  }
  return (
    <>
      <ConfigCard icon={Tags} title={t('workspaces.config.categoriesTitle')}
        description={t('workspaces.config.categoriesDescription')}>
        <CategoriesManager />
      </ConfigCard>
      <ConfigCard icon={Layers} title={t('workspaces.config.dimensionsTitle')}
        description={t('workspaces.config.dimensionsDescription')}>
        <DimensionsManager />
      </ConfigCard>
      <ConfigCard icon={ShieldCheck} title={t('workspaces.config.sourcesTitle')}
        description={t('workspaces.config.sourcesDescription')}>
        <SourcesManager withErasure={false} />
      </ConfigCard>
    </>
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
