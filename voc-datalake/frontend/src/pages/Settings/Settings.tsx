/**
 * @fileoverview Administration (was Settings) — admin-only
 * operational configuration at `/admin` (`/settings` redirects here).
 * @module pages/Settings
 *
 * Six tabs grouped by job, some with a section switch (`?tab=<tab>&section=<section>`,
 * model and pre-5.09 id mapping in `adminTabs.ts`):
 * - General (brand; the dev-only API configuration). Software settings only:
 *   "Reset local settings" moved to Account → This browser (docs/account-vs-admin.md)
 * - Sources: Data sources, Integrations, Email inbox, Radar
 * - Taxonomy: Categories, Dimensions
 * - Privacy & access: Source policies, Users
 * - AI models
 * - System: Logs, Version
 */

import { brandSettingsKey } from '../../hooks/useBrandSettings'
import { useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { useConfigStore } from '../../store/configStore'
import { useIsAdmin } from '../../store/authStore'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import { api } from '../../api/client'
import clsx from 'clsx'
import { TabsTrack } from './TabsTrack'
import { SectionSwitch } from './SectionSwitch'
import AdminSectionContent from './AdminSectionContent'
import { SECTION_PANEL_ID, buildSections, buildTabs, sectionTabId } from './adminTabLabels'
import { isLeavingAdmin, useAdminLocation } from './useAdminLocation'
import { useApiEndpointField, useBrandForm } from './useSettingsSync'
import { Header, ApiConfigSection, BrandConfigSection } from './SettingsSections'

/** A non-General tab's content: the tabpanel of the section switch when one is shown. */
function SectionPanel({ labelledBy, children }: Readonly<{ labelledBy: string | null; children: ReactNode }>) {
  if (labelledBy === null) return <div className="space-y-4 sm:space-y-6">{children}</div>
  return (
    <div id={SECTION_PANEL_ID} role="tabpanel" aria-labelledby={labelledBy} className="space-y-4 sm:space-y-6">
      {children}
    </div>
  )
}

export default function Settings() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const { config, setConfig } = useConfigStore()
  const isAdmin = useIsAdmin()
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const { location, selectTab, selectSection, redirectTo } = useAdminLocation(isAdmin)
  const activeTab = location.tab
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const { apiEndpoint, setApiEndpoint } = useApiEndpointField(config.apiEndpoint, setConfig)

  const {
    data: backendSettings, isLoading: loadingSettings, isError: brandLoadFailed, refetch: refetchBrand,
  } = useQuery({
    queryKey: brandSettingsKey(),
    queryFn: () => api.getBrandSettings(),
    enabled: !!config.apiEndpoint,
  })

  const {
    brandName, setBrandName,
    brandHandles, setBrandHandles,
    hashtags, setHashtags,
    urlsToTrack, setUrlsToTrack,
    dirty: brandDirty, markSaved: markBrandSaved, discard: discardBrand,
  } = useBrandForm(config, setConfig, backendSettings)

  const parseArrayInput = (input: string, separator: string): string[] =>
    input.split(separator).map(s => s.trim()).filter(Boolean)

  /** Returns false when the backend rejected the save, so the header never claims "Saved!" for it. */
  const saveToBackend = async (brandHandlesArray: string[], hashtagsArray: string[], urlsArray: string[]): Promise<boolean> => {
    setSaving(true)
    try {
      await api.saveBrandSettings({
        brand_name: brandName,
        brand_handles: brandHandlesArray,
        hashtags: hashtagsArray,
        urls_to_track: urlsArray,
      })
      void queryClient.invalidateQueries({ queryKey: brandSettingsKey() })
      return true
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to save brand settings:', err)
      return false
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async (): Promise<boolean> => {
    const brandHandlesArray = parseArrayInput(brandHandles, ',')
    const hashtagsArray = parseArrayInput(hashtags, ',')
    const urlsArray = parseArrayInput(urlsToTrack, '\n')

    setConfig({
      apiEndpoint,
      brandName,
      brandHandles: brandHandlesArray,
      hashtags: hashtagsArray,
      urlsToTrack: urlsArray,
      sources: config.sources,
    })

    const ok = apiEndpoint ? await saveToBackend(brandHandlesArray, hashtagsArray, urlsArray) : true
    setSaveFailed(!ok)
    setSaved(ok)
    if (ok) {
      markBrandSaved()
      setTimeout(() => setSaved(false), 3000)
    }
    return ok
  }
  // Brand edits live at page level, so switching tabs (a query change) keeps them; leaving the page asks (E2E F6).
  const guard = useUnsavedChangesGuard({ dirty: brandDirty, onSave: handleSave, onDiscard: discardBrand, shouldBlock: isLeavingAdmin })

  const tabs = buildTabs(t, isAdmin)
  const sections = buildSections(t, activeTab, isAdmin)

  const activeTabData = tabs.find(t => t.id === activeTab)

  return (
    // min-w-0: inside the shell's flex column, a wide child (the logs tab track)
    // would otherwise stretch the page past 390px instead of scrolling itself.
    <div className="max-w-5xl mx-auto min-w-0 w-full">
      {redirectTo !== null && <Navigate to={redirectTo} replace />}
      <Header saved={saved} saving={saving} saveFailed={saveFailed} canSave={isAdmin} showSave={activeTab === 'brand'} onSave={() => void handleSave()} />
      {guard.dialog}

      {/* Mobile Tab Dropdown */}
      <div className="sm:hidden mb-4">
        <button
          type="button"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-expanded={mobileMenuOpen}
          aria-controls="settings-mobile-tabs"
          className="w-full flex items-center justify-between px-3 py-2.5 text-sm bg-bg-elevated border border-border rounded-lg hover:border-border-strong transition-colors focus-ring"
        >
          <span className="flex items-center gap-2">
            {activeTabData && <activeTabData.icon size={16} className="text-accent-text" />}
            <span className="font-medium text-text-strong">{activeTabData?.label}</span>
          </span>
          <ChevronDown size={16} className={clsx('text-muted transition-transform', mobileMenuOpen && 'rotate-180')} />
        </button>
        {mobileMenuOpen && (
          <div id="settings-mobile-tabs" className="menu mt-1">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => { selectTab(tab.id); setMobileMenuOpen(false) }}
                type="button"
                aria-current={activeTab === tab.id ? 'page' : undefined}
                className={clsx(
                  'menu-item w-full flex items-center gap-2 py-2.5',
                  activeTab === tab.id && 'nav-active'
                )}
              >
                <tab.icon size={14} />
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Desktop Tabs */}
      <div className="hidden sm:block tabs-rail mb-6">
        <TabsTrack tabs={tabs} active={activeTab} onSelect={selectTab} />
      </div>

      {location.section !== null && (
        <SectionSwitch sections={sections} active={location.section} onSelect={selectSection} label={activeTabData?.label ?? ''} />
      )}

      {/* Tab Content */}
      {activeTab === 'brand' ? (
        <div className="space-y-4 sm:space-y-6">
          <ApiConfigSection
            apiEndpoint={apiEndpoint}
            onApiEndpointChange={setApiEndpoint}
          />
          <BrandConfigSection
            apiEndpoint={apiEndpoint}
            loadingSettings={loadingSettings}
            loadFailed={brandLoadFailed}
            onRetry={() => void refetchBrand()}
            brandName={brandName}
            brandHandles={brandHandles}
            hashtags={hashtags}
            urlsToTrack={urlsToTrack}
            onBrandNameChange={setBrandName}
            onBrandHandlesChange={setBrandHandles}
            onHashtagsChange={setHashtags}
            onUrlsToTrackChange={setUrlsToTrack}
            readOnly={!isAdmin}
          />
        </div>
      ) : (
        <SectionPanel labelledBy={sections.length > 1 && location.section !== null ? sectionTabId(location.section) : null}>
          <AdminSectionContent tab={activeTab} section={location.section} apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
        </SectionPanel>
      )}
    </div>
  )
}
