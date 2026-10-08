/**
 * @fileoverview Administration (was Settings; todofeatures §6.1) — admin-only
 * operational configuration at `/admin` (`/settings` redirects here).
 * @module pages/Settings
 *
 * Tabs (`?tab=` deep-links one):
 * - General & brand
 * - Data Sources (Plugins)
 * - Categories taxonomy
 * - Dimensions (product / module / user type …) — admin
 * - Sources (PII policy, retention, restriction, erasure) — admin
 * - Users (roles, category access, flags)
 * - AI models (per-surface model picker)
 * - Integrations (Figma / GitHub secrets)
 * - Logs
 */

import { brandSettingsKey } from '../../hooks/useBrandSettings'
import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Tags, Users, Building2, Plug, FileWarning, ChevronDown, Cpu, KeyRound, Layers, ShieldCheck,
} from 'lucide-react'
import { useConfigStore } from '../../store/configStore'
import { useIsAdmin } from '../../store/authStore'
import { useUnsavedChangesGuard } from '../../components/UnsavedChangesGuard/useUnsavedChangesGuard'
import { api } from '../../api/client'
import clsx from 'clsx'
import LogsSection from './LogsSection'
import AiModelSection from './AiModelSection'
import IntegrationsSection from './IntegrationsSection'
import { TabsTrack } from './TabsTrack'
import { DimensionsSection, SourcesSection } from './DataGovernanceSections'
import { useApiEndpointField, useBrandForm } from './useSettingsSync'
import {
  Header, ApiConfigSection, BrandConfigSection, CategoriesSection, DataSourcesSection, UserAdminSection, DangerZoneSection,
} from './SettingsSections'

const SETTINGS_TABS = ['brand', 'plugins', 'categories', 'dimensions', 'sources', 'users', 'ai', 'integrations', 'logs'] as const
type SettingsTab = typeof SETTINGS_TABS[number]

function isSettingsTab(value: string | null): value is SettingsTab {
  return SETTINGS_TABS.some((tab) => tab === value)
}

/** `?tab=categories` deep-links a tab (the Home onboarding step links to it). */
function useInitialTab(): SettingsTab {
  const [searchParams] = useSearchParams()
  const requested = searchParams.get('tab')
  return isSettingsTab(requested) ? requested : 'brand'
}

interface SettingsTabDef {
  readonly id: SettingsTab
  readonly label: string
  readonly icon: typeof Users
}

function buildTabs(t: (key: string) => string, isAdmin: boolean): SettingsTabDef[] {
  const adminOnly = (def: SettingsTabDef): SettingsTabDef[] => (isAdmin ? [def] : [])
  return [
    { id: 'brand', label: t('tabs.general'), icon: Building2 },
    { id: 'plugins', label: t('tabs.plugins'), icon: Plug },
    { id: 'categories', label: t('tabs.categories'), icon: Tags },
    ...adminOnly({ id: 'dimensions', label: t('tabs.dimensions'), icon: Layers }),
    ...adminOnly({ id: 'sources', label: t('tabs.sources'), icon: ShieldCheck }),
    ...adminOnly({ id: 'users', label: t('tabs.users'), icon: Users }),
    { id: 'ai', label: t('tabs.ai'), icon: Cpu },
    ...adminOnly({ id: 'integrations', label: t('tabs.integrations'), icon: KeyRound }),
    { id: 'logs', label: t('tabs.logs'), icon: FileWarning },
  ]
}

/** The admin-only tabs; nothing for anyone else (their tab buttons are hidden too). */
function AdminTabContent({ tab, apiEndpoint }: Readonly<{ tab: SettingsTab; apiEndpoint: string }>) {
  switch (tab) {
    case 'dimensions': return <DimensionsSection />
    case 'sources': return <SourcesSection />
    case 'users': return <UserAdminSection apiEndpoint={apiEndpoint} />
    case 'integrations': return <IntegrationsSection />
    default: return null
  }
}

/** Every tab but General & brand, whose form state lives in Settings itself. */
function OtherTabContent({ tab, apiEndpoint, isAdmin }: Readonly<{ tab: SettingsTab; apiEndpoint: string; isAdmin: boolean }>) {
  switch (tab) {
    case 'plugins': return <DataSourcesSection apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
    case 'categories': return <CategoriesSection apiEndpoint={apiEndpoint} />
    case 'ai': return <AiModelSection apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
    case 'logs': return <LogsSection apiEndpoint={apiEndpoint} />
    default: return isAdmin ? <AdminTabContent tab={tab} apiEndpoint={apiEndpoint} /> : null
  }
}

export default function Settings() {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const { config, setConfig } = useConfigStore()
  const isAdmin = useIsAdmin()
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const initialTab = useInitialTab()
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab)
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
  // Brand edits live at page level, so switching tabs keeps them; leaving the page asks (E2E F6).
  const guard = useUnsavedChangesGuard({ dirty: brandDirty, onSave: handleSave, onDiscard: discardBrand })

  const tabs = buildTabs(t, isAdmin)

  const activeTabData = tabs.find(t => t.id === activeTab)

  return (
    // min-w-0: inside the shell's flex column, a wide child (the logs tab track)
    // would otherwise stretch the page past 390px instead of scrolling itself.
    <div className="max-w-5xl mx-auto min-w-0 w-full">
      <Header saved={saved} saving={saving} saveFailed={saveFailed} onSave={() => void handleSave()} />
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
                onClick={() => { setActiveTab(tab.id); setMobileMenuOpen(false) }}
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
        <TabsTrack tabs={tabs} active={activeTab} onSelect={setActiveTab} />
      </div>

      {/* Tab Content */}
      <div className="space-y-4 sm:space-y-6">
        {activeTab === 'brand' && (
          <>
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
            />
            <DangerZoneSection
              showResetConfirm={showResetConfirm}
              onShowResetConfirm={setShowResetConfirm}
              onReset={() => {
                setConfig({ apiEndpoint: '', brandName: '', brandHandles: [], hashtags: [], urlsToTrack: [] })
                setApiEndpoint('')
                setBrandName('')
                setBrandHandles('')
                setHashtags('')
                setUrlsToTrack('')
                setShowResetConfirm(false)
              }}
            />
          </>
        )}

        <OtherTabContent tab={activeTab} apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
      </div>
    </div>
  )
}
