/**
 * @fileoverview The deployment's default brand, in the platform console (Administration → Privacy & access →
 * Workspaces): `GET` and `PUT /settings/brand` with NO `X-Workspace-Id` (api/brandApi.ts, the client's explicit
 * opt-out), so it reaches the deployment-wide row from any address. Before it, nobody with a workspace could reach
 * that row from the web app: the gate always enters a workspace, and inside one the brand form edits the workspace's.
 *
 * The save is the deployment's `admins`' (`require_settings_admin` with no workspace: `require_admin`), the gate this
 * card follows (`useIsAdmin`, a hint: the server decides); the console itself is shown to platform admins, who are
 * all in `admins`. A 403 is said in words.
 *
 * @module pages/Settings/DeploymentBrandCard
 */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { useIsAdmin } from '../../store/authStore'
import { brandSettingsKey } from '../../hooks/useBrandSettings'
import { deploymentBrandApi, deploymentBrandKey } from '../../api/brandApi'
import { DEPLOYMENT_BRAND_REFUSALS } from '../../workspace/workspaceRefusals'
import BrandEditorCard from './BrandEditorCard'
import { EMPTY_BRAND_FIELDS, useBrandDraft } from './useSettingsSync'

export default function DeploymentBrandCard() {
  const { t } = useTranslation()
  const queryClient = useQueryClient()
  const isAdmin = useIsAdmin()
  const query = useQuery({ queryKey: deploymentBrandKey(), queryFn: deploymentBrandApi.get })
  // Not the browser's saved brand: that one is the current workspace's inside a workspace.
  const draft = useBrandDraft(EMPTY_BRAND_FIELDS, query.data)
  return (
    <BrandEditorCard
      title={t('workspaces.deploymentBrand.title')}
      description={t('workspaces.deploymentBrand.description')}
      idPrefix="deployment-brand"
      load={query}
      draft={draft}
      canEdit={isAdmin}
      readOnlyNotice={t('workspaces.deploymentBrand.readOnly')}
      save={deploymentBrandApi.save}
      // Outside a workspace the app's own brand is this row too: refresh every brand read.
      onSaved={() => queryClient.invalidateQueries({ queryKey: brandSettingsKey() })}
      refusals={DEPLOYMENT_BRAND_REFUSALS}
    />
  )
}
