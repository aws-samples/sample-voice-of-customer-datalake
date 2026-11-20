/**
 * @fileoverview Administration → General (`/admin/general`, main's first tab, 7.59.00 again; 7.54.00's Brand &
 * appearance): the brand (`#brand`), where the form brand is set, the deployment's default theme (`#theme`) and, in
 * development builds only, the API endpoint under Advanced (`#api`).
 *
 * Each card saves itself (7.54.00, T6: main's page-level Save saved the brand only, and its "Saved" vanished after 3 s).
 * The brand is the workspace's inside a workspace (its admins change it; useBrandEditRight.ts), kept in this browser's
 * config too (`useBrandForm`). An unsaved brand or theme edit is under the shared unsaved-changes guard: leaving the
 * tab asks (useAdminLocation.ts `leavesAdminTab`); a card's hash and an overlay such as `?review=` do not.
 *
 * @module pages/Settings/GeneralTab
 */
import { useState } from 'react'
import { Trans, useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import CollapsibleSection from '../../components/CollapsibleSection/CollapsibleSection'
import { api } from '../../api/client'
import { brandSettingsKey, useBrandSettings } from '../../hooks/useBrandSettings'
import { useConfigStore } from '../../store/configStore'
import { useCurrentWorkspace } from '../../workspace/currentWorkspace'
import { BRAND_REFUSALS } from '../../workspace/workspaceRefusals'
import BrandEditorCard from './BrandEditorCard'
import DefaultThemeCard from './DefaultThemeCard'
import { CardAnchor } from './CardAnchor'
import { ApiConfigSection } from './SettingsSections'
import { leavesAdminTab } from './useAdminLocation'
import { useBrandEditRight } from './useBrandEditRight'
import { useBrandForm } from './useSettingsSync'

interface GeneralTabProps {
  /** The API endpoint field (the dev-only Advanced card edits it; Settings.tsx keeps it in step with the store). */
  readonly apiEndpoint: string
  readonly onApiEndpointChange: (value: string) => void
  readonly isAdmin: boolean
  readonly isPlatformAdmin: boolean
}

function AdminBrandCard({ isAdmin }: Readonly<{ isAdmin: boolean }>) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const { config, setConfig } = useConfigStore()
  const query = useBrandSettings(config.apiEndpoint)
  const draft = useBrandForm(config, setConfig, query.data)
  const canEdit = useBrandEditRight(isAdmin)
  // Inside a workspace the brand is the workspace's, and only its admins change it.
  const inWorkspace = useCurrentWorkspace() !== null
  // (the description says where the form brand is: `form_theme` on the same row, saved from a form's Style panel)
  return (
    <BrandEditorCard
      title={t('brand.title')}
      description={<Trans i18nKey="general.formBrand" ns="settings" components={{ forms: <Link to="/feedback-forms" className="link" /> }} />}
      idPrefix="settings-brand"
      load={query}
      draft={draft}
      canEdit={canEdit}
      readOnlyNotice={inWorkspace ? t('common:workspaces.settings.brandReadOnly') : t('brand.adminOnlyNotice')}
      save={(payload) => api.saveBrandSettings(payload)}
      onSaved={() => queryClient.invalidateQueries({ queryKey: brandSettingsKey() })}
      refusals={BRAND_REFUSALS}
      shouldBlock={leavesAdminTab}
    />
  )
}

/** The dev-only API endpoint, folded under Advanced; open when no endpoint is set yet. */
function AdvancedApi({ apiEndpoint, onApiEndpointChange }: Readonly<Pick<GeneralTabProps, 'apiEndpoint' | 'onApiEndpointChange'>>) {
  const { t } = useTranslation('settings')
  const setConfig = useConfigStore((state) => state.setConfig)
  const [open, setOpen] = useState(apiEndpoint === '')
  return (
    <CollapsibleSection title={t('sections.advanced')} open={open} onOpenChange={setOpen}>
      <ApiConfigSection apiEndpoint={apiEndpoint} onApiEndpointChange={onApiEndpointChange}
        onSave={() => setConfig({ apiEndpoint })} />
    </CollapsibleSection>
  )
}

export default function GeneralTab({ apiEndpoint, onApiEndpointChange, isAdmin, isPlatformAdmin }: GeneralTabProps) {
  return (
    <>
      <CardAnchor card="brand"><AdminBrandCard isAdmin={isAdmin} /></CardAnchor>
      {/* The deployment's start theme: a platform admin's (every admin may see it). */}
      <CardAnchor card="theme"><DefaultThemeCard apiEndpoint={apiEndpoint} canEdit={isPlatformAdmin} /></CardAnchor>
      {import.meta.env.DEV
        ? <CardAnchor card="api"><AdvancedApi apiEndpoint={apiEndpoint} onApiEndpointChange={onApiEndpointChange} /></CardAnchor>
        : null}
    </>
  )
}
