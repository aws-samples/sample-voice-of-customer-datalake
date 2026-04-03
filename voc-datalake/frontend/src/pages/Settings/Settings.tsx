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
import {
  useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import {
  getRuntimeConfig, isConfigLoaded,
} from '../../runtimeConfig'
import { useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import LogsSection from './LogsSection'
import {
  Header, ApiConfigSection, BrandConfigSection, ReviewConfigSection,
  CategoriesSection, DataSourcesSection, UserAdminSection, DangerZoneSection,
} from './SettingsSections'

type SettingsTab = 'general' | 'plugins' | 'categories' | 'logs' | 'users'

const parseArrayInput = (input: string, separator: string): string[] =>
  input.split(separator).map((s) => s.trim()).filter(Boolean)

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

  const [apiEndpoint, setApiEndpoint] = useState(() => {
    if (isConfigLoaded()) return getRuntimeConfig().apiEndpoint
    return config.apiEndpoint
  })
  const [brandName, setBrandName] = useState(config.brandName)
  const [brandHandles, setBrandHandles] = useState(config.brandHandles.join(', '))
  const [hashtags, setHashtags] = useState(config.hashtags.join(', '))
  const [urlsToTrack, setUrlsToTrack] = useState(config.urlsToTrack.join('\n'))

  useEffect(() => {
    if (isConfigLoaded()) {
      const runtimeConfig = getRuntimeConfig()
      if (runtimeConfig.apiEndpoint !== '' && runtimeConfig.apiEndpoint !== config.apiEndpoint) {
        setConfig({ apiEndpoint: runtimeConfig.apiEndpoint })
        setApiEndpoint(runtimeConfig.apiEndpoint)
      }
    }
  }, [config.apiEndpoint, setConfig])

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

  const [primaryLanguage, setPrimaryLanguage] = useState('en')

  useEffect(() => {
    if (!backendSettings) return
    if ('error' in backendSettings && backendSettings.error != null && backendSettings.error !== '') return
    const name = backendSettings.brand_name
    const handles = backendSettings.brand_handles
    const tags = backendSettings.hashtags
    const urls = backendSettings.urls_to_track
    setBrandName(name)
    setBrandHandles(handles.join(', '))
    setHashtags(tags.join(', '))
    setUrlsToTrack(urls.join('\n'))
    setConfig({
      brandName: name,
      brandHandles: handles,
      hashtags: tags,
      urlsToTrack: urls,
    })
  }, [backendSettings, setConfig])

  useEffect(() => {
    if (reviewSettings?.primary_language != null && reviewSettings.primary_language !== '') setPrimaryLanguage(reviewSettings.primary_language)
  }, [reviewSettings])

  const saveToBackend = async (brandHandlesArray: string[], hashtagsArray: string[], urlsArray: string[]) => {
    setSaving(true)
    try {
      await Promise.all([
        api.saveBrandSettings({
          brand_name: brandName,
          brand_handles: brandHandlesArray,
          hashtags: hashtagsArray,
          urls_to_track: urlsArray,
        }),
        api.saveReviewSettings({ primary_language: primaryLanguage }),
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
    const brandHandlesArray = parseArrayInput(brandHandles, ',')
    const hashtagsArray = parseArrayInput(hashtags, ',')
    const urlsArray = parseArrayInput(urlsToTrack, '\n')
    setConfig({
      apiEndpoint,
      brandName,
      brandHandles: brandHandlesArray,
      hashtags: hashtagsArray,
      urlsToTrack: urlsArray,
    })
    if (apiEndpoint !== '') await saveToBackend(brandHandlesArray, hashtagsArray, urlsArray)
    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const tabs = [
    {
      id: 'general' as const,
      label: t('tabs.general'),
      icon: Building2,
    },
    {
      id: 'plugins' as const,
      label: t('tabs.plugins'),
      icon: Plug,
    },
    {
      id: 'categories' as const,
      label: t('tabs.categories'),
      icon: Tags,
    },
    {
      id: 'logs' as const,
      label: t('tabs.logs'),
      icon: FileWarning,
    },
    ...(isAdmin ? [{
      id: 'users' as const,
      label: t('tabs.users'),
      icon: Users,
    }] : []),
  ]

  const activeTabData = tabs.find((tab) => tab.id === activeTab)

  const handleReset = () => {
    setConfig({
      apiEndpoint: '',
      brandName: '',
      brandHandles: [],
      hashtags: [],
      urlsToTrack: [],
    })
    setApiEndpoint('')
    setBrandName('')
    setBrandHandles('')
    setHashtags('')
    setUrlsToTrack('')
    setShowResetConfirm(false)
  }

  return (
    <div className="max-w-5xl mx-auto">
      <Header saved={saved} saving={saving} onSave={() => void handleSave()} />
      <MobileTabMenu tabs={tabs} activeTab={activeTab} activeTabData={activeTabData} mobileMenuOpen={mobileMenuOpen} onToggleMenu={() => setMobileMenuOpen(!mobileMenuOpen)} onSelectTab={(id) => {
        setActiveTab(id); setMobileMenuOpen(false)
      }} />
      <DesktopTabs tabs={tabs} activeTab={activeTab} onSelectTab={setActiveTab} />
      <div className="space-y-6">
        {activeTab === 'general' && (
          <>
            <ApiConfigSection apiEndpoint={apiEndpoint} onApiEndpointChange={setApiEndpoint} />
            <BrandConfigSection apiEndpoint={apiEndpoint} loadingSettings={loadingSettings} brandName={brandName} brandHandles={brandHandles} hashtags={hashtags} urlsToTrack={urlsToTrack} onBrandNameChange={setBrandName} onBrandHandlesChange={setBrandHandles} onHashtagsChange={setHashtags} onUrlsToTrackChange={setUrlsToTrack} />
            <ReviewConfigSection apiEndpoint={apiEndpoint} loadingReview={loadingReview} primaryLanguage={primaryLanguage} onPrimaryLanguageChange={setPrimaryLanguage} />
            <DangerZoneSection showResetConfirm={showResetConfirm} onShowResetConfirm={setShowResetConfirm} onReset={handleReset} />
          </>
        )}
        {activeTab === 'plugins' && <DataSourcesSection apiEndpoint={apiEndpoint} />}
        {activeTab === 'categories' && <CategoriesSection apiEndpoint={apiEndpoint} />}
        {activeTab === 'logs' && <LogsSection apiEndpoint={apiEndpoint} />}
        {activeTab === 'users' && isAdmin ? <UserAdminSection apiEndpoint={apiEndpoint} /> : null}
      </div>
    </div>
  )
}

interface TabItem {
  readonly id: SettingsTab
  readonly label: string
  readonly icon: typeof Building2
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
