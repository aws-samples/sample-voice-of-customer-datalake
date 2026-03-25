/**
 * @fileoverview Settings page with tabbed navigation.
 * @module pages/Settings
 * 
 * Sections:
 * - Brand Configuration
 * - Data Sources (Plugins)
 * - Categories
 * - Logs (validation failures, processing errors, scraper logs)
 * - User Administration (admin only)
 */

import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { 
  Save, Check, AlertCircle, Loader2, CheckCircle2, Tags, Users, 
  Building2, Plug, FileWarning, ChevronDown, Languages
} from 'lucide-react'
import { useConfigStore } from '../../store/configStore'
import { useIsAdmin } from '../../store/authStore'
import { useTranslation } from 'react-i18next'
import { supportedLanguages, languageNames, changeLanguage } from '../../i18n/config'
import { api } from '../../api/client'
import CategoriesManager from '../../components/CategoriesManager'
import UserAdmin from '../../components/UserAdmin'
import clsx from 'clsx'
import ConfirmModal from '../../components/ConfirmModal'
import SourceCard from './SourceCard'
import LogsSection from './LogsSection'
import { getEnabledPlugins } from '../../plugins'
import { getRuntimeConfig, isConfigLoaded } from '../../runtimeConfig'
import { SUPPORTED_LANGUAGES } from '../../constants/languages'

type SettingsTab = 'general' | 'plugins' | 'categories' | 'logs' | 'users'

export default function Settings() {
  const queryClient = useQueryClient()
  const { config, setConfig } = useConfigStore()
  const isAdmin = useIsAdmin()
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [activeTab, setActiveTab] = useState<SettingsTab>('general')
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  const [apiEndpoint, setApiEndpoint] = useState(() => {
    // Prefer runtime config (from config.json) over persisted store value
    if (isConfigLoaded()) {
      return getRuntimeConfig().apiEndpoint
    }
    return config.apiEndpoint
  })
  const [brandName, setBrandName] = useState(config.brandName)
  const [brandHandles, setBrandHandles] = useState(config.brandHandles.join(', '))
  const [hashtags, setHashtags] = useState(config.hashtags.join(', '))
  const [urlsToTrack, setUrlsToTrack] = useState(config.urlsToTrack.join('\n'))

  // Sync config store with runtime config on mount
  useEffect(() => {
    if (isConfigLoaded()) {
      const runtimeConfig = getRuntimeConfig()
      if (runtimeConfig.apiEndpoint && runtimeConfig.apiEndpoint !== config.apiEndpoint) {
        setConfig({ apiEndpoint: runtimeConfig.apiEndpoint })
        setApiEndpoint(runtimeConfig.apiEndpoint)
      }
    }
  }, [config.apiEndpoint, setConfig])

  const { data: backendSettings, isLoading: loadingSettings } = useQuery({
    queryKey: ['brand-settings'],
    queryFn: () => api.getBrandSettings(),
    enabled: !!config.apiEndpoint,
  })

  const { data: reviewSettings, isLoading: loadingReview } = useQuery({
    queryKey: ['review-settings'],
    queryFn: () => api.getReviewSettings(),
    enabled: !!config.apiEndpoint,
  })

  const [primaryLanguage, setPrimaryLanguage] = useState('en')

  useEffect(() => {
    if (!backendSettings) return
    if ('error' in backendSettings && backendSettings.error) return

    const name = backendSettings.brand_name ?? ''
    const handles = backendSettings.brand_handles ?? []
    const tags = backendSettings.hashtags ?? []
    const urls = backendSettings.urls_to_track ?? []

    setBrandName(name)
    setBrandHandles(handles.join(', '))
    setHashtags(tags.join(', '))
    setUrlsToTrack(urls.join('\n'))
    setConfig({ brandName: name, brandHandles: handles, hashtags: tags, urlsToTrack: urls })
  }, [backendSettings, setConfig])

  useEffect(() => {
    if (reviewSettings?.primary_language) {
      setPrimaryLanguage(reviewSettings.primary_language)
    }
  }, [reviewSettings])

  const parseArrayInput = (input: string, separator: string): string[] =>
    input.split(separator).map(s => s.trim()).filter(Boolean)

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
        api.saveReviewSettings({
          primary_language: primaryLanguage,
        }),
      ])
      queryClient.invalidateQueries({ queryKey: ['brand-settings'] })
      queryClient.invalidateQueries({ queryKey: ['review-settings'] })
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
      sources: config.sources,
    })

    if (apiEndpoint) {
      await saveToBackend(brandHandlesArray, hashtagsArray, urlsArray)
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  const { t } = useTranslation('settings')

  const tabs = [
    { id: 'general' as const, label: t('tabs.general'), icon: Building2 },
    { id: 'plugins' as const, label: t('tabs.plugins'), icon: Plug },
    { id: 'categories' as const, label: t('tabs.categories'), icon: Tags },
    { id: 'logs' as const, label: t('tabs.logs'), icon: FileWarning },
    ...(isAdmin ? [{ id: 'users' as const, label: t('tabs.users'), icon: Users }] : []),
  ]

  const activeTabData = tabs.find(t => t.id === activeTab)

  return (
    <div className="max-w-5xl mx-auto">
      <Header saved={saved} saving={saving} onSave={handleSave} />

      {/* Mobile Tab Dropdown */}
      <div className="sm:hidden mb-4">
        <button
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="w-full flex items-center justify-between px-4 py-3 bg-white border border-gray-200 rounded-lg"
        >
          <div className="flex items-center gap-2">
            {activeTabData && <activeTabData.icon size={18} className="text-gray-600" />}
            <span className="font-medium">{activeTabData?.label}</span>
          </div>
          <ChevronDown size={18} className={clsx('text-gray-400 transition-transform', mobileMenuOpen && 'rotate-180')} />
        </button>
        {mobileMenuOpen && (
          <div className="mt-1 bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
            {tabs.map(tab => (
              <button
                key={tab.id}
                onClick={() => { setActiveTab(tab.id); setMobileMenuOpen(false) }}
                className={clsx(
                  'w-full flex items-center gap-2 px-4 py-3 text-left hover:bg-gray-50',
                  activeTab === tab.id && 'bg-blue-50 text-blue-700'
                )}
              >
                <tab.icon size={18} />
                {tab.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Desktop Tabs */}
      <div className="hidden sm:flex border-b border-gray-200 mb-6">
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={clsx(
              'flex items-center gap-2 px-4 py-3 border-b-2 -mb-px transition-colors',
              activeTab === tab.id
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            )}
          >
            <tab.icon size={18} />
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div className="space-y-6">
        {activeTab === 'general' && (
          <>
            <ApiConfigSection
              apiEndpoint={apiEndpoint}
              onApiEndpointChange={setApiEndpoint}
            />
            <BrandConfigSection
              apiEndpoint={apiEndpoint}
              loadingSettings={loadingSettings}
              brandName={brandName}
              brandHandles={brandHandles}
              hashtags={hashtags}
              urlsToTrack={urlsToTrack}
              onBrandNameChange={setBrandName}
              onBrandHandlesChange={setBrandHandles}
              onHashtagsChange={setHashtags}
              onUrlsToTrackChange={setUrlsToTrack}
            />
            <ReviewConfigSection
              apiEndpoint={apiEndpoint}
              loadingReview={loadingReview}
              primaryLanguage={primaryLanguage}
              onPrimaryLanguageChange={setPrimaryLanguage}
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

        {activeTab === 'plugins' && (
          <DataSourcesSection apiEndpoint={apiEndpoint} />
        )}

        {activeTab === 'categories' && (
          <CategoriesSection apiEndpoint={apiEndpoint} />
        )}

        {activeTab === 'logs' && (
          <LogsSection apiEndpoint={apiEndpoint} />
        )}

        {activeTab === 'users' && isAdmin && (
          <UserAdminSection apiEndpoint={apiEndpoint} />
        )}
      </div>
    </div>
  )
}

// ============================================
// Header Component
// ============================================

interface HeaderProps {
  readonly saved: boolean
  readonly saving: boolean
  readonly onSave: () => void
}

function getSaveButtonContent(saving: boolean, saved: boolean, t: (key: string) => string): { icon: React.ReactNode; text: string } {
  if (saving) return { icon: <Loader2 size={18} className="animate-spin" />, text: t('saving') }
  if (saved) return { icon: <Check size={18} />, text: t('saved') }
  return { icon: <Save size={18} />, text: t('saveChanges') }
}

function Header({ saved, saving, onSave }: HeaderProps) {
  const { t } = useTranslation('settings')
  const buttonContent = getSaveButtonContent(saving, saved, t)
  const buttonClass = saved ? 'bg-green-600 text-white' : 'btn-primary'

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-sm sm:text-base text-gray-500">{t('subtitle')}</p>
      </div>
      <button
        onClick={onSave}
        disabled={saving}
        className={clsx('btn flex items-center justify-center gap-2 w-full sm:w-auto', buttonClass, saving && 'opacity-75 cursor-not-allowed')}
      >
        {buttonContent.icon}
        {buttonContent.text}
      </button>
    </div>
  )
}

// ============================================
// API Config Section
// ============================================

interface ApiConfigSectionProps {
  readonly apiEndpoint: string
  readonly onApiEndpointChange: (value: string) => void
}

function ApiConfigSection({ apiEndpoint, onApiEndpointChange }: ApiConfigSectionProps) {
  const { t } = useTranslation('settings')
  const [showApiConfig, setShowApiConfig] = useState(!apiEndpoint)

  return (
    <div className="card">
      <button
        onClick={() => setShowApiConfig(!showApiConfig)}
        className="w-full flex items-center justify-between text-left"
      >
        <h2 className="text-lg font-semibold">{t('api.title')}</h2>
        <div className="flex items-center gap-2">
          {apiEndpoint && <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={14} /> {t('api.connected')}</span>}
          <ChevronDown size={18} className={clsx('text-gray-400 transition-transform', showApiConfig && 'rotate-180')} />
        </div>
      </button>
      
      {showApiConfig && (
        <div className="space-y-4 mt-4 pt-4 border-t border-gray-100">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">{t('api.endpointLabel')}</label>
            <input type="url" value={apiEndpoint} onChange={(e) => onApiEndpointChange(e.target.value)} placeholder={t('api.endpointPlaceholder')} className="input" />
            <p className="text-xs text-gray-500 mt-1">{t('api.endpointHint')}</p>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================
// Brand Config Section
// ============================================

interface BrandConfigSectionProps {
  readonly apiEndpoint: string
  readonly loadingSettings: boolean
  readonly brandName: string
  readonly brandHandles: string
  readonly hashtags: string
  readonly urlsToTrack: string
  readonly onBrandNameChange: (value: string) => void
  readonly onBrandHandlesChange: (value: string) => void
  readonly onHashtagsChange: (value: string) => void
  readonly onUrlsToTrackChange: (value: string) => void
}

function BrandConfigSection({ apiEndpoint, loadingSettings, brandName, brandHandles, hashtags, urlsToTrack, onBrandNameChange, onBrandHandlesChange, onHashtagsChange, onUrlsToTrackChange }: BrandConfigSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{t('brand.title')}</h2>
        {apiEndpoint && <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={14} /> {t('brand.syncedToBackend')}</span>}
      </div>
      {loadingSettings && apiEndpoint && (
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
          <Loader2 size={16} className="animate-spin" />{t('brand.loadingSettings')}
        </div>
      )}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('brand.nameLabel')}</label>
          <input type="text" value={brandName} onChange={(e) => onBrandNameChange(e.target.value)} placeholder={t('brand.namePlaceholder')} className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('brand.handlesLabel')}</label>
          <input type="text" value={brandHandles} onChange={(e) => onBrandHandlesChange(e.target.value)} placeholder={t('brand.handlesPlaceholder')} className="input" />
          <p className="text-xs text-gray-500 mt-1">{t('brand.handlesHint')}</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('brand.hashtagsLabel')}</label>
          <input type="text" value={hashtags} onChange={(e) => onHashtagsChange(e.target.value)} placeholder={t('brand.hashtagsPlaceholder')} className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('brand.urlsLabel')}</label>
          <textarea value={urlsToTrack} onChange={(e) => onUrlsToTrackChange(e.target.value)} placeholder="https://example.com/reviews&#10;https://forum.example.com" className="input min-h-[100px]" />
          <p className="text-xs text-gray-500 mt-1">{t('brand.urlsHint')}</p>
        </div>
      </div>
    </div>
  )
}

// ============================================
// Review Config Section
// ============================================

interface ReviewConfigSectionProps {
  readonly apiEndpoint: string
  readonly loadingReview: boolean
  readonly primaryLanguage: string
  readonly onPrimaryLanguageChange: (value: string) => void
}

function ReviewConfigSection({ apiEndpoint, loadingReview, primaryLanguage, onPrimaryLanguageChange }: ReviewConfigSectionProps) {
  const { t, i18n } = useTranslation('settings')

  const handleUiLanguageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    changeLanguage(e.target.value)
  }

  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Languages className="text-blue-600" size={20} />
          <h2 className="text-lg font-semibold">{t('language.title')}</h2>
        </div>
        {apiEndpoint && <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={14} /> {t('brand.syncedToBackend')}</span>}
      </div>
      {loadingReview && apiEndpoint && (
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
          <Loader2 size={16} className="animate-spin" />{t('language.loadingReview')}
        </div>
      )}
      <div className="space-y-4">
        <div>
          <label htmlFor="ui-language" className="block text-sm font-medium text-gray-700 mb-1">
            {t('language.interfaceLabel')}
          </label>
          <select
            id="ui-language"
            value={i18n.language}
            onChange={handleUiLanguageChange}
            className="input"
          >
            {supportedLanguages.map((lang) => (
              <option key={lang} value={lang}>
                {languageNames[lang]}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {t('language.interfaceHint')}
          </p>
        </div>
        <div>
          <label htmlFor="primary-language" className="block text-sm font-medium text-gray-700 mb-1">
            {t('language.reviewLabel')}
          </label>
          <select
            id="primary-language"
            value={primaryLanguage}
            onChange={(e) => onPrimaryLanguageChange(e.target.value)}
            className="input"
          >
            {SUPPORTED_LANGUAGES.map((lang) => (
              <option key={lang.code} value={lang.code}>
                {lang.name} ({lang.code})
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-1">
            {t('language.reviewHint')}
          </p>
        </div>
      </div>
    </div>
  )
}

// ============================================
// Categories Section
// ============================================

interface CategoriesSectionProps {
  readonly apiEndpoint: string
}

function CategoriesSection({ apiEndpoint }: CategoriesSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Tags className="text-purple-600" size={20} />
        <h2 className="text-lg font-semibold">{t('categories.title')}</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">{t('categories.description')}</p>
      {!apiEndpoint ? (
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{t('categories.configureFirst')}</span>
        </div>
      ) : (
        <CategoriesManager />
      )}
    </div>
  )
}

// ============================================
// Data Sources Section
// ============================================

interface DataSourcesSectionProps {
  readonly apiEndpoint: string
}

function DataSourcesSection({ apiEndpoint }: DataSourcesSectionProps) {
  const { t } = useTranslation('settings')
  const pluginManifests = getEnabledPlugins()

  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-lg font-semibold mb-2">{t('dataSources.title')}</h2>
        <p className="text-sm text-gray-500 mb-4">{t('dataSources.description')}</p>
        {!apiEndpoint && (
          <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg mb-4">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>{t('dataSources.configureFirst')}</span>
          </div>
        )}
      </div>
      <div className="space-y-3 sm:space-y-4">
        {pluginManifests.length === 0 ? (
          <div className="card text-sm text-gray-500">
            No data source plugins found. Run <code className="bg-gray-200 px-1 rounded">npm run generate:manifests</code> to generate plugin manifests.
          </div>
        ) : (
          pluginManifests.map((manifest) => (
            <SourceCard key={manifest.id} manifest={manifest} apiEndpoint={apiEndpoint} />
          ))
        )}
      </div>
    </div>
  )
}

// ============================================
// User Admin Section
// ============================================

interface UserAdminSectionProps {
  readonly apiEndpoint: string
}

function UserAdminSection({ apiEndpoint }: UserAdminSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Users className="text-indigo-600" size={20} />
        <h2 className="text-lg font-semibold">{t('users.title')}</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">{t('users.description')}</p>
      {!apiEndpoint ? (
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{t('users.configureFirst')}</span>
        </div>
      ) : (
        <UserAdmin />
      )}
    </div>
  )
}

// ============================================
// Danger Zone Section
// ============================================

interface DangerZoneSectionProps {
  readonly showResetConfirm: boolean
  readonly onShowResetConfirm: (show: boolean) => void
  readonly onReset: () => void
}

function DangerZoneSection({ showResetConfirm, onShowResetConfirm, onReset }: DangerZoneSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <>
      <div className="card border-red-200">
        <h2 className="text-lg font-semibold text-red-600 mb-4">{t('dangerZone.title')}</h2>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
          <div>
            <p className="font-medium text-sm sm:text-base">{t('dangerZone.resetTitle')}</p>
            <p className="text-xs sm:text-sm text-gray-500">{t('dangerZone.resetDescription')}</p>
          </div>
          <button onClick={() => onShowResetConfirm(true)} className="btn bg-red-600 text-white hover:bg-red-700 w-full sm:w-auto">
            {t('dangerZone.resetButton')}
          </button>
        </div>
      </div>
      <ConfirmModal
        isOpen={showResetConfirm}
        title={t('dangerZone.resetTitle')}
        message={t('dangerZone.resetConfirmMessage')}
        confirmLabel={t('dangerZone.resetConfirmLabel')}
        variant="danger"
        onConfirm={onReset}
        onCancel={() => onShowResetConfirm(false)}
      />
    </>
  )
}
