/**
 * @fileoverview Settings page for API configuration and integrations.
 * @module pages/Settings
 */

import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, Check, AlertCircle, Loader2, CheckCircle2, Tags, Users } from 'lucide-react'
import { useConfigStore } from '../../store/configStore'
import { useIsAdmin } from '../../store/authStore'
import { api } from '../../api/client'
import CategoriesManager from '../../components/CategoriesManager'
import UserAdmin from '../../components/UserAdmin'
import clsx from 'clsx'
import ConfirmModal from '../../components/ConfirmModal'
import SourceCard from './SourceCard'
import { sourceInfo } from './sourceConfig'

export default function Settings() {
  const queryClient = useQueryClient()
  const { config, setConfig } = useConfigStore()
  const isAdmin = useIsAdmin()
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)

  const [apiEndpoint, setApiEndpoint] = useState(config.apiEndpoint)
  const [artifactBuilderEndpoint, setArtifactBuilderEndpoint] = useState(config.artifactBuilderEndpoint)
  const [brandName, setBrandName] = useState(config.brandName)
  const [brandHandles, setBrandHandles] = useState(config.brandHandles.join(', '))
  const [hashtags, setHashtags] = useState(config.hashtags.join(', '))
  const [urlsToTrack, setUrlsToTrack] = useState(config.urlsToTrack.join('\n'))

  const { data: backendSettings, isLoading: loadingSettings } = useQuery({
    queryKey: ['brand-settings'],
    queryFn: () => api.getBrandSettings(),
    enabled: !!config.apiEndpoint,
  })

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

  const parseArrayInput = (input: string, separator: string): string[] =>
    input.split(separator).map(s => s.trim()).filter(Boolean)

  const saveToBackend = async (brandHandlesArray: string[], hashtagsArray: string[], urlsArray: string[]) => {
    setSaving(true)
    try {
      await api.saveBrandSettings({
        brand_name: brandName,
        brand_handles: brandHandlesArray,
        hashtags: hashtagsArray,
        urls_to_track: urlsArray,
      })
      queryClient.invalidateQueries({ queryKey: ['brand-settings'] })
    } catch (err) {
      if (import.meta.env.DEV) console.error('Failed to save brand settings:', err)
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
      artifactBuilderEndpoint,
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

  return (
    <div className="max-w-4xl mx-auto space-y-6 sm:space-y-8">
      <Header saved={saved} saving={saving} onSave={handleSave} />

      <ApiConfigSection
        apiEndpoint={apiEndpoint}
        artifactBuilderEndpoint={artifactBuilderEndpoint}
        onApiEndpointChange={setApiEndpoint}
        onArtifactBuilderEndpointChange={setArtifactBuilderEndpoint}
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

      <CategoriesSection apiEndpoint={apiEndpoint} />

      <DataSourcesSection apiEndpoint={apiEndpoint} />

      {isAdmin && <UserAdminSection apiEndpoint={apiEndpoint} />}

      <DangerZoneSection
        showResetConfirm={showResetConfirm}
        onShowResetConfirm={setShowResetConfirm}
        onReset={() => {
          setConfig({ apiEndpoint: '', artifactBuilderEndpoint: '', brandName: '', brandHandles: [], hashtags: [], urlsToTrack: [] })
          setApiEndpoint('')
          setArtifactBuilderEndpoint('')
          setBrandName('')
          setBrandHandles('')
          setHashtags('')
          setUrlsToTrack('')
          setShowResetConfirm(false)
        }}
      />
    </div>
  )
}

interface HeaderProps {
  readonly saved: boolean
  readonly saving: boolean
  readonly onSave: () => void
}

function getSaveButtonContent(saving: boolean, saved: boolean): { icon: React.ReactNode; text: string } {
  if (saving) return { icon: <Loader2 size={18} className="animate-spin" />, text: 'Saving...' }
  if (saved) return { icon: <Check size={18} />, text: 'Saved!' }
  return { icon: <Save size={18} />, text: 'Save Changes' }
}

function Header({ saved, saving, onSave }: HeaderProps) {
  const buttonContent = getSaveButtonContent(saving, saved)
  const buttonClass = saved ? 'bg-green-600 text-white' : 'btn-primary'

  return (
    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
      <div>
        <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Settings</h1>
        <p className="text-sm sm:text-base text-gray-500">Configure your VoC platform, data sources, and integrations</p>
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

interface ApiConfigSectionProps {
  readonly apiEndpoint: string
  readonly artifactBuilderEndpoint: string
  readonly onApiEndpointChange: (value: string) => void
  readonly onArtifactBuilderEndpointChange: (value: string) => void
}

function ApiConfigSection({ apiEndpoint, artifactBuilderEndpoint, onApiEndpointChange, onArtifactBuilderEndpointChange }: ApiConfigSectionProps) {
  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-4">API Configuration</h2>
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">API Endpoint URL</label>
          <input type="url" value={apiEndpoint} onChange={(e) => onApiEndpointChange(e.target.value)} placeholder="https://your-api-id.execute-api.region.amazonaws.com/v1" className="input" />
          <p className="text-xs text-gray-500 mt-1">The API Gateway endpoint from your VoC deployment</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Artifact Builder Endpoint URL</label>
          <input type="url" value={artifactBuilderEndpoint} onChange={(e) => onArtifactBuilderEndpointChange(e.target.value)} placeholder="https://artifact-builder-api.execute-api.region.amazonaws.com/v1" className="input" />
          <p className="text-xs text-gray-500 mt-1">The Artifact Builder API endpoint for generating prototypes from PR/FAQs</p>
        </div>
      </div>
    </div>
  )
}

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
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold">Brand Configuration</h2>
        {apiEndpoint && <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={14} /> Synced to backend</span>}
      </div>
      {loadingSettings && apiEndpoint && (
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
          <Loader2 size={16} className="animate-spin" />Loading settings from server...
        </div>
      )}
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Brand Name</label>
          <input type="text" value={brandName} onChange={(e) => onBrandNameChange(e.target.value)} placeholder="Your Brand Name" className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Brand Handles (comma-separated)</label>
          <input type="text" value={brandHandles} onChange={(e) => onBrandHandlesChange(e.target.value)} placeholder="@yourbrand, yourbrand, YourBrand" className="input" />
          <p className="text-xs text-gray-500 mt-1">Social media handles and variations to track</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Hashtags to Track (comma-separated)</label>
          <input type="text" value={hashtags} onChange={(e) => onHashtagsChange(e.target.value)} placeholder="#yourbrand, #yourproduct" className="input" />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">URLs to Track (one per line)</label>
          <textarea value={urlsToTrack} onChange={(e) => onUrlsToTrackChange(e.target.value)} placeholder="https://example.com/reviews&#10;https://forum.example.com" className="input min-h-[100px]" />
          <p className="text-xs text-gray-500 mt-1">Specific URLs to monitor via web search</p>
        </div>
      </div>
    </div>
  )
}

interface CategoriesSectionProps {
  readonly apiEndpoint: string
}

function CategoriesSection({ apiEndpoint }: CategoriesSectionProps) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Tags className="text-purple-600" size={20} />
        <h2 className="text-lg font-semibold">Feedback Categories</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">Configure categories and subcategories for feedback classification.</p>
      {!apiEndpoint ? (
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>Configure the API endpoint above to manage categories.</span>
        </div>
      ) : (
        <CategoriesManager />
      )}
    </div>
  )
}

interface DataSourcesSectionProps {
  readonly apiEndpoint: string
}

function DataSourcesSection({ apiEndpoint }: DataSourcesSectionProps) {
  return (
    <div className="card">
      <h2 className="text-lg font-semibold mb-2">Data Sources & Integrations</h2>
      <p className="text-sm text-gray-500 mb-4">Configure API credentials, webhooks, and enable/disable data source schedules.</p>
      {!apiEndpoint && (
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg mb-4">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>Configure the API endpoint above to manage data sources.</span>
        </div>
      )}
      <div className="space-y-3 sm:space-y-4">
        {Object.entries(sourceInfo).map(([key, info]) => (
          <SourceCard key={key} sourceKey={key} info={info} apiEndpoint={apiEndpoint} />
        ))}
      </div>
    </div>
  )
}

interface UserAdminSectionProps {
  readonly apiEndpoint: string
}

function UserAdminSection({ apiEndpoint }: UserAdminSectionProps) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 mb-4">
        <Users className="text-indigo-600" size={20} />
        <h2 className="text-lg font-semibold">User Administration</h2>
      </div>
      <p className="text-sm text-gray-500 mb-4">Manage users, roles, and permissions for the VoC platform.</p>
      {!apiEndpoint ? (
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>Configure the API endpoint above to manage users.</span>
        </div>
      ) : (
        <UserAdmin />
      )}
    </div>
  )
}

interface DangerZoneSectionProps {
  readonly showResetConfirm: boolean
  readonly onShowResetConfirm: (show: boolean) => void
  readonly onReset: () => void
}

function DangerZoneSection({ showResetConfirm, onShowResetConfirm, onReset }: DangerZoneSectionProps) {
  return (
    <>
      <div className="card border-red-200">
        <h2 className="text-lg font-semibold text-red-600 mb-4">Danger Zone</h2>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
          <div>
            <p className="font-medium text-sm sm:text-base">Reset All Settings</p>
            <p className="text-xs sm:text-sm text-gray-500">Clear all local configuration. This won&apos;t affect backend data.</p>
          </div>
          <button onClick={() => onShowResetConfirm(true)} className="btn bg-red-600 text-white hover:bg-red-700 w-full sm:w-auto">
            Reset Settings
          </button>
        </div>
      </div>
      <ConfirmModal
        isOpen={showResetConfirm}
        title="Reset All Settings"
        message="Are you sure you want to reset all local settings? This will clear your API endpoint, brand configuration, and all local preferences. Backend data will not be affected."
        confirmLabel="Reset"
        variant="danger"
        onConfirm={onReset}
        onCancel={() => onShowResetConfirm(false)}
      />
    </>
  )
}
