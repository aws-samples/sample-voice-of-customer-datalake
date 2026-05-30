/**
 * @fileoverview Settings page with tabbed navigation.
 * @module pages/Settings
 */

import {
  useQuery, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Building2, Plug, Tags, FileWarning, Users, ChevronDown,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import LogsSection from './LogsSection'
import {
  Header, ApiConfigSection, BrandConfigSection, ReviewConfigSection,
  CategoriesSection, DataSourcesSection, UserAdminSection, DangerZoneSection,
} from './SettingsSections'
import { useSettingsForm } from './useSettingsForm'

type SettingsTab = 'general' | 'plugins' | 'categories' | 'logs' | 'users'

const parseArrayInput = (input: string, separator: string): string[] =>
  input.split(separator).map((s) => s.trim()).filter(Boolean)

interface BrandSettingsResponse {
  brand_name: string
  brand_handles: string[]
  hashtags: string[]
  urls_to_track: string[]
  error?: string
}

function isValidBrandResponse(
  data: BrandSettingsResponse | undefined,
): data is BrandSettingsResponse {
  if (data == null) return false
  const errorPresent = 'error' in data && data.error != null && data.error !== ''
  return !errorPresent
}

export default function Settings() {
  const queryClient = useQueryClient()
  const {
    config, setConfig,
  } = useConfigStore()
  const isAdmin = useIsAdmin()
  const { t } = useTranslation('settings')
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const {
    data: backendSettings, isLoading: loadingSettings,
  } = useQuery({
    queryKey: ['brand-settings'],
    queryFn: () => api.getBrandSettings(),
    enabled: config.apiEndpoint.length > 0,
  })

  const {
    data: reviewSettings, isLoading: loadingReview,
  } = useQuery({
    queryKey: ['review-settings'],
    queryFn: () => api.getReviewSettings(),
    enabled: config.apiEndpoint.length > 0,
  })

  const serverBrand = isValidBrandResponse(backendSettings) ? backendSettings : null

  const form = useSettingsForm({
    serverBrand,
    reviewSettings,
    storeConfig: config,
  })
  const { values } = form

  const saveToBackend = async (
    brandHandlesArray: string[],
    hashtagsArray: string[],
    urlsArray: string[],
  ) => {
    setSaving(true)
    try {
      await Promise.all([
        api.saveBrandSettings({
          brand_name: values.brandName,
          brand_handles: brandHandlesArray,
          hashtags: hashtagsArray,
          urls_to_track: urlsArray,
        }),
        api.saveReviewSettings({ primary_language: values.primaryLanguage }),
      ])
      void queryClient.invalidateQueries({ queryKey: ['brand-settings'] })
      void queryClient.invalidateQueries({ queryKey: ['review-settings'] })
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to save settings:', err)
    } finally {
      setSaving(false)
    }
  }

  const handleSave = async () => {
    const brandHandlesArray = parseArrayInput(values.brandHandles, ',')
    const hashtagsArray = parseArrayInput(values.hashtags, ',')
    const urlsArray = parseArrayInput(values.urlsToTrack, '\n')
    setConfig({
      apiEndpoint: values.apiEndpoint,
      brandName: values.brandName,
      brandHandles: brandHandlesArray,
      hashtags: hashtagsArray,
      urlsToTrack: urlsArray,
    })
    if (values.apiEndpoint !== '') {
      await saveToBackend(brandHandlesArray, hashtagsArray, urlsArray)
    }
    form.clearEdits()
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const handleReset = () => {
    setConfig({
      apiEndpoint: '',
      brandName: '',
      brandHandles: [],
      hashtags: [],
      urlsToTrack: [],
    })
    form.resetToEmpty()
    setShowResetConfirm(false)
  }

  const tabs = buildTabs(t, isAdmin)
  const activeTabData = tabs.find((tab) => tab.id === activeTab)

  return (
    <div className="max-w-5xl mx-auto">
      <Header saved={saved} saving={saving} onSave={() => void handleSave()} />
      <MobileTabMenu
        tabs={tabs}
        activeTab={activeTab}
        activeTabData={activeTabData}
        mobileMenuOpen={mobileMenuOpen}
        onToggleMenu={() => setMobileMenuOpen(!mobileMenuOpen)}
        onSelectTab={(id) => {
          setActiveTab(id)
          setMobileMenuOpen(false)
        }}
      />
      <DesktopTabs tabs={tabs} activeTab={activeTab} onSelectTab={setActiveTab} />
      <SettingsTabContent
        activeTab={activeTab}
        isAdmin={isAdmin}
        form={form}
        loadingSettings={loadingSettings}
        loadingReview={loadingReview}
        showResetConfirm={showResetConfirm}
        onShowResetConfirm={setShowResetConfirm}
        onReset={handleReset}
      />
    </div>
  )
}

interface TabItem {
  readonly id: SettingsTab
  readonly label: string
  readonly icon: typeof Building2
}

function buildTabs(t: (key: string) => string, isAdmin: boolean): TabItem[] {
  const base: TabItem[] = [
    {
      id: 'general',
      label: t('tabs.general'),
      icon: Building2,
    },
    {
      id: 'plugins',
      label: t('tabs.plugins'),
      icon: Plug,
    },
    {
      id: 'categories',
      label: t('tabs.categories'),
      icon: Tags,
    },
    {
      id: 'logs',
      label: t('tabs.logs'),
      icon: FileWarning,
    },
  ]
  if (isAdmin) {
    base.push({
      id: 'users',
      label: t('tabs.users'),
      icon: Users,
    })
  }
  return base
}

function SettingsTabContent({
  activeTab, isAdmin, form, loadingSettings, loadingReview,
  showResetConfirm, onShowResetConfirm, onReset,
}: {
  readonly activeTab: SettingsTab
  readonly isAdmin: boolean
  readonly form: ReturnType<typeof useSettingsForm>
  readonly loadingSettings: boolean
  readonly loadingReview: boolean
  readonly showResetConfirm: boolean
  readonly onShowResetConfirm: (v: boolean) => void
  readonly onReset: () => void
}) {
  const { values } = form
  return (
    <div className="space-y-6">
      {activeTab === 'general' && (
        <>
          <ApiConfigSection
            apiEndpoint={values.apiEndpoint}
            onApiEndpointChange={form.setApiEndpoint}
          />
          <BrandConfigSection
            apiEndpoint={values.apiEndpoint}
            loadingSettings={loadingSettings}
            brandName={values.brandName}
            brandHandles={values.brandHandles}
            hashtags={values.hashtags}
            urlsToTrack={values.urlsToTrack}
            onBrandNameChange={form.setBrandName}
            onBrandHandlesChange={form.setBrandHandles}
            onHashtagsChange={form.setHashtags}
            onUrlsToTrackChange={form.setUrlsToTrack}
          />
          <ReviewConfigSection
            apiEndpoint={values.apiEndpoint}
            loadingReview={loadingReview}
            primaryLanguage={values.primaryLanguage}
            onPrimaryLanguageChange={form.setPrimaryLanguage}
          />
          <DangerZoneSection
            showResetConfirm={showResetConfirm}
            onShowResetConfirm={onShowResetConfirm}
            onReset={onReset}
          />
        </>
      )}
      {activeTab === 'plugins' && <DataSourcesSection apiEndpoint={values.apiEndpoint} />}
      {activeTab === 'categories' && <CategoriesSection apiEndpoint={values.apiEndpoint} />}
      {activeTab === 'logs' && <LogsSection apiEndpoint={values.apiEndpoint} />}
      {activeTab === 'users' && isAdmin ? <UserAdminSection apiEndpoint={values.apiEndpoint} /> : null}
    </div>
  )
}

function MobileTabMenu({
  tabs, activeTab, activeTabData, mobileMenuOpen, onToggleMenu, onSelectTab,
}: {
  readonly tabs: TabItem[]
  readonly activeTab: SettingsTab
  readonly activeTabData: TabItem | undefined
  readonly mobileMenuOpen: boolean
  readonly onToggleMenu: () => void
  readonly onSelectTab: (id: SettingsTab) => void
}) {
  return (
    <div className="sm:hidden mb-4">
      <button onClick={onToggleMenu} className="w-full flex items-center justify-between px-4 py-3 bg-white border border-gray-200 rounded-lg">
        <div className="flex items-center gap-2">
          {activeTabData ? <activeTabData.icon size={18} className="text-gray-600" /> : null}
          <span className="font-medium">{activeTabData?.label}</span>
        </div>
        <ChevronDown size={18} className={clsx('text-gray-400 transition-transform', mobileMenuOpen && 'rotate-180')} />
      </button>
      {mobileMenuOpen ? <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
        {tabs.map((tab) => (
          <button key={tab.id} onClick={() => onSelectTab(tab.id)} className={clsx('w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50', activeTab === tab.id && 'bg-blue-50 text-blue-700')}>
            <tab.icon size={18} />
            {tab.label}
          </button>
        ))}
      </div> : null}
    </div>
  )
}

function DesktopTabs({
  tabs, activeTab, onSelectTab,
}: {
  readonly tabs: TabItem[]
  readonly activeTab: SettingsTab
  readonly onSelectTab: (id: SettingsTab) => void
}) {
  return (
    <div className="hidden sm:flex border-b border-gray-200 mb-6">
      {tabs.map((tab) => (
        <button key={tab.id} onClick={() => onSelectTab(tab.id)} className={clsx('flex items-center gap-2 px-4 py-3 border-b-2 -mb-px transition-colors', activeTab === tab.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300')}>
          <tab.icon size={18} />
          {tab.label}
        </button>
      ))}
    </div>
  )
}
