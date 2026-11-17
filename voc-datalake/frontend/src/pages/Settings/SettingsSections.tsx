/**
 * @fileoverview Parts of Administration's pages: the dev-only API endpoint field, the brand fields, the Categories
 * card and the Data sources cards (health first).
 * @module pages/Settings/SettingsSections
 */

import { useState } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import {
  Save, AlertCircle, Loader2, CheckCircle2, Tags, Lock,
} from 'lucide-react'
import CategoriesManager from '../../components/CategoriesManager/CategoriesManager'
import SavedStatus from '../../components/SavedStatus/SavedStatus'
import SourceCard from './SourceCard'
import { api } from '../../api/client'
import { sourcesStatusKey } from '../../api/queryKeys'
import type { SourceStatus } from '../../api/sourcesStatusSchema'
import { getEnabledPlugins } from '../../plugins'
import { ownValue } from '../Scrapers/scraper-helpers'
import { SECTION_TITLE } from './sectionTitle'
import WorkspaceConfigNotice from '../../workspace/WorkspaceConfigNotice'
import { ConfigScopeContext, scopedKey, useConfigScope } from '../../workspace/configScope'

/** A save button's content: "Saving…" while the save runs, else "Save changes" (the card's SavedStatus says Saved). */
export function SaveButtonContent({ saving }: Readonly<{ saving: boolean }>) {
  const { t } = useTranslation('settings')
  if (saving) return <><Loader2 size={16} className="animate-spin" />{t('saving')}</>
  return <><Save size={16} />{t('saveChanges')}</>
}

// ============================================
// Shared bits
// ============================================

export function ConfigureFirstNotice({ message }: Readonly<{ message: string }>) {
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
  /** Keep the endpoint in this browser's config (the field's value). */
  readonly onSave: () => void
}

/**
 * The API endpoint field, under Brand & appearance → Advanced, shown only in development builds (the caller renders
 * it only there; this checks again).
 *
 * In a production build the API endpoint comes solely from the deployment's runtime config (config.json) and cannot
 * be edited. This prevents a social-engineering attack where a user is persuaded to paste a foreign URL and the app
 * then sends their Cognito bearer token to it. Like every card it saves itself (its own Save, one Saved).
 */
export function ApiConfigSection({ apiEndpoint, onApiEndpointChange, onSave }: ApiConfigSectionProps) {
  const { t } = useTranslation('settings')
  const [saved, setSaved] = useState(false)

  // Production builds: no editable endpoint field.
  if (!import.meta.env.DEV) return null

  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); onSave(); setSaved(true) }}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold tracking-tight text-text-strong">{t('api.title')}</h3>
        {apiEndpoint && <span className="badge badge-ok flex items-center gap-1"><CheckCircle2 size={12} /> {t('api.connected')}</span>}
      </div>
      <div>
        <label htmlFor="settings-api-endpoint" className="block text-sm font-medium text-text mb-1">{t('api.endpointLabel')}</label>
        <input id="settings-api-endpoint" type="url" value={apiEndpoint}
          onChange={(e) => { setSaved(false); onApiEndpointChange(e.target.value) }} placeholder={t('api.endpointPlaceholder')} className="input" />
        <p className="text-xs text-muted mt-1">{t('api.endpointHint')}</p>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="submit" className="btn btn-primary btn-sm"><Save size={14} aria-hidden="true" /> {t('saveChanges')}</button>
        <SavedStatus saved={saved} />
      </div>
    </form>
  )
}

// ============================================
// Brand Config Section
// ============================================

export function BrandSyncStatus({ apiEndpoint, loadingSettings, loadFailed }: Readonly<{ apiEndpoint: string; loadingSettings: boolean; loadFailed: boolean }>) {
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

/** Why the brand is read-only here: the text names who may change it. */
export function BrandReadOnlyNotice({ text }: Readonly<{ text: string }>) {
  return (
    <p className="flex items-start gap-2 text-sm text-text bg-info-subtle border border-info/30 p-3 rounded-lg mb-4">
      <Lock size={16} className="flex-shrink-0 mt-0.5 text-info" aria-hidden="true" />
      {text}
    </p>
  )
}

/** The brand form's four fields, as text, with their change handlers. */
export interface BrandFieldValues {
  readonly brandName: string
  readonly brandHandles: string
  readonly hashtags: string
  readonly urlsToTrack: string
  readonly setBrandName: (value: string) => void
  readonly setBrandHandles: (value: string) => void
  readonly setHashtags: (value: string) => void
  readonly setUrlsToTrack: (value: string) => void
}

/**
 * The four brand fields. `idPrefix` keeps their ids unique where two brand forms could share a page; `readOnly`
 * disables every one of them.
 */
export function BrandFields({ values, readOnly, idPrefix = 'settings-brand' }: Readonly<{
  values: BrandFieldValues
  readOnly: boolean
  idPrefix?: string
}>) {
  const { t } = useTranslation('settings')
  return (
    <div className="space-y-4">
      <BrandField id={`${idPrefix}-name`} label={t('brand.nameLabel')}>
        <input id={`${idPrefix}-name`} disabled={readOnly} type="text" value={values.brandName} onChange={(e) => values.setBrandName(e.target.value)} placeholder={t('brand.namePlaceholder')} className="input" />
      </BrandField>
      <BrandField id={`${idPrefix}-handles`} label={t('brand.handlesLabel')} hint={t('brand.handlesHint')}>
        <input id={`${idPrefix}-handles`} disabled={readOnly} type="text" value={values.brandHandles} onChange={(e) => values.setBrandHandles(e.target.value)} placeholder={t('brand.handlesPlaceholder')} className="input" />
      </BrandField>
      <BrandField id={`${idPrefix}-hashtags`} label={t('brand.hashtagsLabel')}>
        <input id={`${idPrefix}-hashtags`} disabled={readOnly} type="text" value={values.hashtags} onChange={(e) => values.setHashtags(e.target.value)} placeholder={t('brand.hashtagsPlaceholder')} className="input" />
      </BrandField>
      <BrandField id={`${idPrefix}-urls`} label={t('brand.urlsLabel')} hint={t('brand.urlsHint')}>
        <textarea id={`${idPrefix}-urls`} disabled={readOnly} value={values.urlsToTrack} onChange={(e) => values.setUrlsToTrack(e.target.value)} placeholder={'https://example.com/reviews\nhttps://forum.example.com'} className="input min-h-[100px]" />
      </BrandField>
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
        <>
          {/* The deployment's categories from any address (inside a workspace the notice says so). */}
          <WorkspaceConfigNotice />
          <ConfigScopeContext.Provider value="deployment"><CategoriesManager /></ConfigScopeContext.Provider>
        </>
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
  /** The source whose card the address opens (`/admin/sources/<source>`), or none. */
  readonly openSource?: string | null
}

/** Paused after errors first, then failing (a failure counted, or an unreadable state), then the rest. */
function healthRank(status: SourceStatus | undefined): number {
  if (status === undefined) return 2
  if (status.circuit.tripped) return 0
  return status.circuit.failure_count > 0 || status.error !== undefined ? 1 : 2
}

/**
 * The cards' order, health first (paused or failing on top), in the manifests' order within each rank. Fixed when the
 * status first arrives, so a card a reset or a toggle heals does not jump away from the pointer while it is used.
 */
function useHealthOrder(apiEndpoint: string, ids: readonly string[]): readonly string[] {
  const scope = useConfigScope()
  // The key and read every SourceCard of the scope shares (useSourceSchedule.ts): one call for the page.
  const { data } = useQuery({
    queryKey: scopedKey(sourcesStatusKey(), scope),
    queryFn: () => api.getSourcesStatus(undefined, scope),
    enabled: apiEndpoint !== '',
  })
  const [order, setOrder] = useState<readonly string[] | null>(null)
  if (order === null && data !== undefined) {
    setOrder([...ids].sort((a, b) => healthRank(ownValue(data.sources, a)) - healthRank(ownValue(data.sources, b))))
  }
  return order ?? ids
}

/** One card per enabled source plugin, health first, in the enclosing scope (workspace/configScope.ts). */
export function DataSourcesSection({ apiEndpoint, isAdmin, openSource = null }: DataSourcesSectionProps) {
  const { t } = useTranslation('settings')
  const pluginManifests = getEnabledPlugins()
  const order = useHealthOrder(apiEndpoint, pluginManifests.map((manifest) => manifest.id))
  const ordered = order.flatMap((id) => pluginManifests.filter((manifest) => manifest.id === id))

  return (
    <div className="space-y-3 sm:space-y-4">
      {apiEndpoint ? null : <ConfigureFirstNotice message={t('dataSources.configureFirst')} />}
      {pluginManifests.length === 0 ? (
        <div className="card text-sm text-muted">
          <Trans
            i18nKey="dataSources.noPlugins"
            ns="settings"
            components={{ code: <code className="bg-bg-hover px-1 rounded-sm font-mono" /> }}
          />
        </div>
      ) : (
        ordered.map((manifest) => (
          <SourceCard key={manifest.id} manifest={manifest} apiEndpoint={apiEndpoint} isAdmin={isAdmin}
            initiallyOpen={manifest.id === openSource} />
        ))
      )}
    </div>
  )
}
