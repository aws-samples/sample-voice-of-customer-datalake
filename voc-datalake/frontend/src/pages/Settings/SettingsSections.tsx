/**
 * @fileoverview Section components for the Settings page.
 * @module pages/Settings/SettingsSections
 */

import clsx from 'clsx'
import {
  AlertCircle, Loader2, CheckCircle2, Tags, Users, ChevronDown, Languages, Save, Check,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import CategoriesManager from '../../components/CategoriesManager'
import ConfirmModal from '../../components/ConfirmModal'
import UserAdmin from '../../components/UserAdmin'
import { SUPPORTED_LANGUAGES } from '../../constants/languages'
import {
  supportedLanguages, languageNames, changeLanguage,
} from '../../i18n/config'
import { getEnabledPlugins } from '../../plugins'
import SourceCard from './SourceCard'

export interface HeaderProps {
  readonly saved: boolean
  readonly saving: boolean
  readonly onSave: () => void
}

function getSaveButtonContent(saving: boolean, saved: boolean, t: (key: string) => string): {
  icon: React.ReactNode;
  text: string
} {
  if (saving) return {
    icon: <Loader2 size={18} className="animate-spin" />,
    text: t('saving'),
  }
  if (saved) return {
    icon: <Check size={18} />,
    text: t('saved'),
  }
  return {
    icon: <Save size={18} />,
    text: t('saveChanges'),
  }
}

export function Header({
  saved, saving, onSave,
}: HeaderProps) {
  const { t } = useTranslation('settings')
  const buttonContent = getSaveButtonContent(saving, saved, t)
  const buttonClass = saved ? 'bg-green-600 text-white' : 'btn-primary'
  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
        <p className="text-sm sm:text-base text-gray-500">{t('subtitle')}</p>
      </div>
      <button onClick={onSave} disabled={saving} className={clsx('btn flex items-center justify-center gap-2 w-full sm:w-auto', buttonClass, saving && 'opacity-75 cursor-not-allowed')}>
        {buttonContent.icon}
        {buttonContent.text}
      </button>
    </div>
  )
}

export interface ApiConfigSectionProps {
  readonly apiEndpoint: string
  readonly onApiEndpointChange: (value: string) => void
}

export function ApiConfigSection({
  apiEndpoint, onApiEndpointChange,
}: ApiConfigSectionProps) {
  const { t } = useTranslation('settings')
  const [showApiConfig, setShowApiConfig] = useState(apiEndpoint === '')
  return (
    <div className="card">
      <button onClick={() => setShowApiConfig(!showApiConfig)} className="w-full flex items-center justify-between text-left">
        <h2 className="text-lg font-semibold">{t('api.title')}</h2>
        <div className="flex items-center gap-2">
          {apiEndpoint === '' ? null : <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={14} /> {t('api.connected')}</span>}
          <ChevronDown size={18} className={clsx('text-gray-400 transition-transform', showApiConfig && 'rotate-180')} />
        </div>
      </button>
      {showApiConfig ? <div className="space-y-4 mt-4 pt-4 border-t border-gray-100">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">{t('api.endpointLabel')}</label>
          <input type="url" value={apiEndpoint} onChange={(e) => onApiEndpointChange(e.target.value)} placeholder={t('api.endpointPlaceholder')} className="input" />
          <p className="text-xs text-gray-500 mt-1">{t('api.endpointHint')}</p>
        </div>
      </div> : null}
    </div>
  )
}

export interface BrandConfigSectionProps {
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

export function BrandConfigSection({
  apiEndpoint, loadingSettings, brandName, brandHandles, hashtags, urlsToTrack, onBrandNameChange, onBrandHandlesChange, onHashtagsChange, onUrlsToTrackChange,
}: BrandConfigSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">{t('brand.title')}</h2>
        {apiEndpoint === '' ? null : <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={14} /> {t('brand.syncedToBackend')}</span>}
      </div>
      {loadingSettings && apiEndpoint !== '' ? <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        <Loader2 size={16} className="animate-spin" />{t('brand.loadingSettings')}
      </div> : null}
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

export interface ReviewConfigSectionProps {
  readonly apiEndpoint: string
  readonly loadingReview: boolean
  readonly primaryLanguage: string
  readonly onPrimaryLanguageChange: (value: string) => void
}

function handleUiLanguageChange(e: React.ChangeEvent<HTMLSelectElement>) {
  void changeLanguage(e.target.value)
}

export function ReviewConfigSection({
  apiEndpoint, loadingReview, primaryLanguage, onPrimaryLanguageChange,
}: ReviewConfigSectionProps) {
  const {
    t, i18n,
  } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <Languages className="text-blue-600" size={20} />
          <h2 className="text-lg font-semibold">{t('language.title')}</h2>
        </div>
        {apiEndpoint === '' ? null : <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={14} /> {t('brand.syncedToBackend')}</span>}
      </div>
      {loadingReview && apiEndpoint !== '' ? <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
        <Loader2 size={16} className="animate-spin" />{t('language.loadingReview')}
      </div> : null}
      <div className="space-y-4">
        <div>
          <label htmlFor="ui-language" className="block text-sm font-medium text-gray-700 mb-1">{t('language.interfaceLabel')}</label>
          <select id="ui-language" value={i18n.language} onChange={handleUiLanguageChange} className="input">
            {supportedLanguages.map((lang) => (<option key={lang} value={lang}>{languageNames[lang]}</option>))}
          </select>
          <p className="text-xs text-gray-500 mt-1">{t('language.interfaceHint')}</p>
        </div>
        <div>
          <label htmlFor="primary-language" className="block text-sm font-medium text-gray-700 mb-1">{t('language.reviewLabel')}</label>
          <select id="primary-language" value={primaryLanguage} onChange={(e) => onPrimaryLanguageChange(e.target.value)} className="input">
            {SUPPORTED_LANGUAGES.map((lang) => (<option key={lang.code} value={lang.code}>{lang.name} ({lang.code})</option>))}
          </select>
          <p className="text-xs text-gray-500 mt-1">{t('language.reviewHint')}</p>
        </div>
      </div>
    </div>
  )
}

export function CategoriesSection({ apiEndpoint }: { readonly apiEndpoint: string }) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Tags className="text-purple-600" size={20} />
        <h2 className="text-lg font-semibold">{t('categories.title')}</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">{t('categories.description')}</p>
      {apiEndpoint === '' ? (
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{t('categories.configureFirst')}</span>
        </div>
      ) : <CategoriesManager />}
    </div>
  )
}

export function DataSourcesSection({ apiEndpoint }: { readonly apiEndpoint: string }) {
  const { t } = useTranslation('settings')
  const pluginManifests = getEnabledPlugins()
  return (
    <div className="space-y-4">
      <div className="card">
        <h2 className="text-lg font-semibold mb-2">{t('dataSources.title')}</h2>
        <p className="text-sm text-gray-500 mb-4">{t('dataSources.description')}</p>
        {apiEndpoint === '' && (
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
        ) : pluginManifests.map((manifest) => (
          <SourceCard key={manifest.id} manifest={manifest} apiEndpoint={apiEndpoint} />
        ))}
      </div>
    </div>
  )
}

export function UserAdminSection({ apiEndpoint }: { readonly apiEndpoint: string }) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Users className="text-indigo-600" size={20} />
        <h2 className="text-lg font-semibold">{t('users.title')}</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">{t('users.description')}</p>
      {apiEndpoint === '' ? (
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{t('users.configureFirst')}</span>
        </div>
      ) : <UserAdmin />}
    </div>
  )
}

export interface DangerZoneSectionProps {
  readonly showResetConfirm: boolean
  readonly onShowResetConfirm: (show: boolean) => void
  readonly onReset: () => void
}

export function DangerZoneSection({
  showResetConfirm, onShowResetConfirm, onReset,
}: DangerZoneSectionProps) {
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
      <ConfirmModal isOpen={showResetConfirm} title={t('dangerZone.resetTitle')} message={t('dangerZone.resetConfirmMessage')} confirmLabel={t('dangerZone.resetConfirmLabel')} variant="danger" onConfirm={onReset} onCancel={() => onShowResetConfirm(false)} />
    </>
  )
}
