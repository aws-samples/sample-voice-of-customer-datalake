/**
 * @fileoverview The Settings page's header and per-tab sections.
 * @module pages/Settings/SettingsSections
 */

import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import {
  Save, Check, AlertCircle, Loader2, CheckCircle2, Tags, Users,
  Plug, ChevronDown, RefreshCw,
} from 'lucide-react'
import CategoriesManager from '../../components/CategoriesManager/CategoriesManager'
import UserAdmin from '../../components/UserAdmin/UserAdmin'
import clsx from 'clsx'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import SourceCard from './SourceCard'
import { getEnabledPlugins } from '../../plugins'

// ============================================
// Header Component
// ============================================

interface HeaderProps {
  readonly saved: boolean
  readonly saving: boolean
  readonly saveFailed: boolean
  readonly onSave: () => void
}

function SaveButtonContent({ saving, saved }: Readonly<{ saving: boolean; saved: boolean }>) {
  const { t } = useTranslation('settings')
  if (saving) return <><Loader2 size={16} className="animate-spin" />{t('saving')}</>
  if (saved) return <><Check size={16} />{t('saved')}</>
  return <><Save size={16} />{t('saveChanges')}</>
}

export function Header({ saved, saving, saveFailed, onSave }: HeaderProps) {
  const { t } = useTranslation('settings')
  const buttonClass = saved ? 'bg-ok text-ok-fg border-ok' : 'btn-primary'

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 mb-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-text-strong">{t('title')}</h1>
        <p className="text-sm text-muted mt-1 max-w-prose">{t('subtitle')}</p>
      </div>
      <div className="flex flex-col sm:items-end gap-1.5">
        <button
          type="button"
          onClick={onSave}
          disabled={saving}
          className={clsx('btn flex items-center justify-center gap-2 w-full sm:w-auto', buttonClass, saving && 'opacity-75 cursor-not-allowed')}
        >
          <SaveButtonContent saving={saving} saved={saved} />
        </button>
        {saveFailed && (
          <p role="alert" className="text-xs text-danger flex items-center gap-1">
            <AlertCircle size={12} /> {t('brand.saveFailed')}
          </p>
        )}
      </div>
    </div>
  )
}

// ============================================
// Shared bits
// ============================================

const SECTION_TITLE = 'text-lg font-semibold tracking-tight text-text-strong'

function ConfigureFirstNotice({ message }: Readonly<{ message: string }>) {
  return (
    <div className="flex items-start gap-2 text-sm text-warn bg-warn-subtle border border-warn/30 p-3 rounded-lg">
      <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
      <span>{message}</span>
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

/**
 * API Configuration section — shown only in development builds.
 *
 * In a production build the API endpoint comes solely from the deployment's
 * runtime config (config.json) and cannot be edited. This prevents a
 * social-engineering attack where a user is persuaded to paste a foreign URL
 * and the app then sends their Cognito bearer token to it.
 *
 * The dev gate lives here rather than in the parent Settings component so the
 * parent's cyclomatic complexity stays within the lint budget.
 */
export function ApiConfigSection({ apiEndpoint, onApiEndpointChange }: ApiConfigSectionProps) {
  const { t } = useTranslation('settings')
  const [showApiConfig, setShowApiConfig] = useState(!apiEndpoint)

  // Production builds: no editable endpoint field.
  if (!import.meta.env.DEV) return null

  return (
    <div className="card">
      <button
        type="button"
        onClick={() => setShowApiConfig(!showApiConfig)}
        aria-expanded={showApiConfig}
        className="w-full flex items-center justify-between text-left rounded-md focus-ring"
      >
        <h2 className={SECTION_TITLE}>{t('api.title')}</h2>
        <span className="flex items-center gap-2">
          {apiEndpoint && <span className="badge badge-ok flex items-center gap-1"><CheckCircle2 size={12} /> {t('api.connected')}</span>}
          <ChevronDown size={16} className={clsx('text-muted transition-transform', showApiConfig && 'rotate-180')} />
        </span>
      </button>

      {showApiConfig && (
        <div className="space-y-4 mt-4 pt-4 border-t border-border">
          <div>
            <label htmlFor="settings-api-endpoint" className="block text-sm font-medium text-text mb-1">{t('api.endpointLabel')}</label>
            <input id="settings-api-endpoint" type="url" value={apiEndpoint} onChange={(e) => onApiEndpointChange(e.target.value)} placeholder={t('api.endpointPlaceholder')} className="input" />
            <p className="text-xs text-muted mt-1">{t('api.endpointHint')}</p>
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
  readonly loadFailed: boolean
  readonly onRetry: () => void
  readonly brandName: string
  readonly brandHandles: string
  readonly hashtags: string
  readonly urlsToTrack: string
  readonly onBrandNameChange: (value: string) => void
  readonly onBrandHandlesChange: (value: string) => void
  readonly onHashtagsChange: (value: string) => void
  readonly onUrlsToTrackChange: (value: string) => void
}

function BrandSyncStatus({ apiEndpoint, loadingSettings, loadFailed }: Readonly<{ apiEndpoint: string; loadingSettings: boolean; loadFailed: boolean }>) {
  const { t } = useTranslation('settings')
  if (!apiEndpoint || loadingSettings) return null
  if (loadFailed) {
    return <span className="badge badge-warn flex items-center gap-1"><AlertCircle size={12} /> {t('brand.notSynced')}</span>
  }
  return <span className="badge badge-ok flex items-center gap-1"><CheckCircle2 size={12} /> {t('brand.syncedToBackend')}</span>
}

function BrandField({ id, label, hint, children }: Readonly<{ id: string; label: string; hint?: string; children: React.ReactNode }>) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium text-text mb-1">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted mt-1">{hint}</p>}
    </div>
  )
}

export function BrandConfigSection({ apiEndpoint, loadingSettings, loadFailed, onRetry, brandName, brandHandles, hashtags, urlsToTrack, onBrandNameChange, onBrandHandlesChange, onHashtagsChange, onUrlsToTrackChange }: BrandConfigSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h2 className={SECTION_TITLE}>{t('brand.title')}</h2>
        <BrandSyncStatus apiEndpoint={apiEndpoint} loadingSettings={loadingSettings} loadFailed={loadFailed} />
      </div>
      {loadingSettings && apiEndpoint && (
        <div className="flex items-center gap-2 text-sm text-muted mb-4">
          <Loader2 size={14} className="animate-spin" />{t('brand.loadingSettings')}
        </div>
      )}
      {loadFailed && apiEndpoint && !loadingSettings && (
        <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-3 text-sm text-danger bg-danger-subtle border border-danger/30 p-3 rounded-lg mb-4">
          <span className="flex items-start gap-2 flex-1">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            {t('brand.loadFailed')}
          </span>
          <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm flex items-center justify-center gap-1.5">
            <RefreshCw size={14} /> {t('brand.retry')}
          </button>
        </div>
      )}
      <div className="space-y-4">
        <BrandField id="settings-brand-name" label={t('brand.nameLabel')}>
          <input id="settings-brand-name" type="text" value={brandName} onChange={(e) => onBrandNameChange(e.target.value)} placeholder={t('brand.namePlaceholder')} className="input" />
        </BrandField>
        <BrandField id="settings-brand-handles" label={t('brand.handlesLabel')} hint={t('brand.handlesHint')}>
          <input id="settings-brand-handles" type="text" value={brandHandles} onChange={(e) => onBrandHandlesChange(e.target.value)} placeholder={t('brand.handlesPlaceholder')} className="input" />
        </BrandField>
        <BrandField id="settings-brand-hashtags" label={t('brand.hashtagsLabel')}>
          <input id="settings-brand-hashtags" type="text" value={hashtags} onChange={(e) => onHashtagsChange(e.target.value)} placeholder={t('brand.hashtagsPlaceholder')} className="input" />
        </BrandField>
        <BrandField id="settings-brand-urls" label={t('brand.urlsLabel')} hint={t('brand.urlsHint')}>
          <textarea id="settings-brand-urls" value={urlsToTrack} onChange={(e) => onUrlsToTrackChange(e.target.value)} placeholder={'https://example.com/reviews\nhttps://forum.example.com'} className="input min-h-[100px]" />
        </BrandField>
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

export function CategoriesSection({ apiEndpoint }: CategoriesSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Tags className="text-accent" size={16} />
        <h2 className={SECTION_TITLE}>{t('categories.title')}</h2>
      </div>
      <p className="text-sm text-muted mb-4">{t('categories.description')}</p>
      {!apiEndpoint ? (
        <ConfigureFirstNotice message={t('categories.configureFirst')} />
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
  readonly isAdmin: boolean
}

export function DataSourcesSection({ apiEndpoint, isAdmin }: DataSourcesSectionProps) {
  const { t } = useTranslation('settings')
  const pluginManifests = getEnabledPlugins()

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center gap-2 mb-1">
          <Plug className="text-accent" size={16} />
          <h2 className={SECTION_TITLE}>{t('dataSources.title')}</h2>
        </div>
        <p className="text-sm text-muted">{t('dataSources.description')}</p>
        {!apiEndpoint && (
          <div className="mt-4">
            <ConfigureFirstNotice message={t('dataSources.configureFirst')} />
          </div>
        )}
      </div>
      <div className="space-y-3 sm:space-y-4">
        {pluginManifests.length === 0 ? (
          <div className="card text-sm text-muted">
            <Trans
              i18nKey="dataSources.noPlugins"
              ns="settings"
              components={{ code: <code className="bg-bg-hover px-1 rounded-sm font-mono" /> }}
            />
          </div>
        ) : (
          pluginManifests.map((manifest) => (
            <SourceCard key={manifest.id} manifest={manifest} apiEndpoint={apiEndpoint} isAdmin={isAdmin} />
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

export function UserAdminSection({ apiEndpoint }: UserAdminSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-1">
        <Users className="text-accent" size={16} />
        <h2 className={SECTION_TITLE}>{t('users.title')}</h2>
      </div>
      <p className="text-sm text-muted mb-4">{t('users.description')}</p>
      {!apiEndpoint ? (
        <ConfigureFirstNotice message={t('users.configureFirst')} />
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

export function DangerZoneSection({ showResetConfirm, onShowResetConfirm, onReset }: DangerZoneSectionProps) {
  const { t } = useTranslation('settings')
  return (
    <>
      <div className="card border-danger/30">
        <h2 className="text-lg font-semibold tracking-tight text-danger mb-4">{t('dangerZone.title')}</h2>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
          <div>
            <p className="font-medium text-sm text-text-strong">{t('dangerZone.resetTitle')}</p>
            <p className="text-sm text-muted">{t('dangerZone.resetDescription')}</p>
          </div>
          <button type="button" onClick={() => onShowResetConfirm(true)} className="btn btn-danger w-full sm:w-auto">
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
