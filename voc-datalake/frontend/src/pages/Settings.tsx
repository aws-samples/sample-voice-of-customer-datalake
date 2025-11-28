import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  Save, Check, AlertCircle, Loader2, Copy, ExternalLink, 
  Eye, EyeOff, CheckCircle2, Webhook, Key, TestTube, Tags
} from 'lucide-react'
import { useConfigStore } from '../store/configStore'
import { api } from '../api/client'
import CategoriesManager from '../components/CategoriesManager'
import clsx from 'clsx'

// Source configuration with fields, webhooks, and setup instructions
const sourceInfo: Record<string, { 
  name: string
  icon: string
  description?: string
  fields: { key: string; label: string; type: string; placeholder?: string; multiline?: boolean }[]
  webhooks?: { name: string; events: string; docUrl?: string }[]
  setupInstructions?: { title: string; color: string; steps: string[] }
}> = {
  trustpilot: {
    name: 'Trustpilot',
    icon: '⭐',
    description: 'Service reviews via webhook and API polling',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
      { key: 'api_secret', label: 'API Secret', type: 'password' },
      { key: 'business_unit_id', label: 'Business Unit ID', type: 'text', placeholder: 'e.g., 5a7b8c9d0e1f2a3b4c5d6e7f' },
    ],
    webhooks: [
      { name: 'Service Reviews', events: 'service-review-created, service-review-updated, service-review-deleted', docUrl: 'https://support.trustpilot.com/hc/en-us/articles/360001108568-Webhooks' }
    ],
    setupInstructions: {
      title: 'Trustpilot Setup',
      color: 'blue',
      steps: [
        'Log in to your Trustpilot Business Portal',
        'Go to Integrations → API to get your API Key and Secret',
        'Copy your Business Unit ID from the URL',
        'Go to Integrations → Webhooks and add the webhook URL',
        'Select events: service-review-created, updated, deleted',
      ]
    }
  },
  yelp: {
    name: 'Yelp Fusion API',
    icon: '🍽️',
    description: 'Business reviews via official Yelp API',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
      { key: 'business_ids', label: 'Business IDs', type: 'text', placeholder: 'lufthansa-frankfurt-am-main-3, lufthansa-los-angeles-2', multiline: true },
    ],
    setupInstructions: {
      title: 'Yelp Setup',
      color: 'orange',
      steps: [
        'Go to Yelp Fusion Developer Portal',
        'Create a new app or use an existing one',
        'Copy your API Key from the app settings',
        'Find business IDs from Yelp URLs (slug after /biz/)',
      ]
    }
  },
  google_reviews: {
    name: 'Google Reviews',
    icon: '🔍',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
      { key: 'location_ids', label: 'Location IDs (comma-separated)', type: 'text' },
    ],
  },
  twitter: {
    name: 'Twitter / X',
    icon: '𝕏',
    fields: [
      { key: 'bearer_token', label: 'Bearer Token', type: 'password' },
    ],
  },
  instagram: {
    name: 'Instagram',
    icon: '📷',
    fields: [
      { key: 'access_token', label: 'Meta Access Token', type: 'password' },
      { key: 'account_id', label: 'Instagram Account ID', type: 'text' },
    ],
    webhooks: [
      { name: 'Comments & Mentions', events: 'comments, mentions' }
    ],
  },
  facebook: {
    name: 'Facebook',
    icon: '📘',
    fields: [
      { key: 'access_token', label: 'Meta Access Token', type: 'password' },
      { key: 'page_id', label: 'Page ID', type: 'text' },
    ],
    webhooks: [
      { name: 'Page Reviews & Comments', events: 'reviews, comments' }
    ],
  },
  reddit: {
    name: 'Reddit',
    icon: '🔴',
    fields: [
      { key: 'client_id', label: 'Client ID', type: 'text' },
      { key: 'client_secret', label: 'Client Secret', type: 'password' },
      { key: 'subreddits', label: 'Subreddits (comma-separated)', type: 'text' },
    ],
  },
  tavily: {
    name: 'Tavily (Web Search)',
    icon: '🌐',
    fields: [
      { key: 'api_key', label: 'API Key', type: 'password' },
    ],
  },
  appstore_apple: {
    name: 'Apple App Store',
    icon: '🍎',
    fields: [
      { key: 'app_id', label: 'App ID (numeric)', type: 'text' },
      { key: 'country_codes', label: 'Country Codes (comma-separated)', type: 'text', placeholder: 'us,gb,de' },
    ],
  },
  appstore_google: {
    name: 'Google Play Store',
    icon: '▶️',
    fields: [
      { key: 'package_name', label: 'Package Name', type: 'text', placeholder: 'com.example.app' },
      { key: 'service_account', label: 'Service Account JSON', type: 'password' },
    ],
  },
  appstore_huawei: {
    name: 'Huawei AppGallery',
    icon: '📱',
    fields: [
      { key: 'client_id', label: 'Client ID', type: 'text' },
      { key: 'client_secret', label: 'Client Secret', type: 'password' },
      { key: 'app_id', label: 'App ID', type: 'text' },
    ],
  },
}

// Source card component with credentials, webhooks, and test functionality
function SourceCard({ sourceKey, info, apiEndpoint }: { 
  sourceKey: string
  info: typeof sourceInfo[string]
  apiEndpoint: string 
}) {
  const queryClient = useQueryClient()
  const [isExpanded, setIsExpanded] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)

  // Server-side status
  const [serverStatus, setServerStatus] = useState<{ enabled: boolean; loading?: boolean }>({ enabled: false })

  const { data: integrationStatus } = useQuery({
    queryKey: ['integration-status'],
    queryFn: () => api.getIntegrationStatus(),
    enabled: !!apiEndpoint,
  })

  const sourceStatus = integrationStatus?.[sourceKey]

  // Fetch source enabled status
  useEffect(() => {
    if (apiEndpoint) {
      api.getSourcesStatus().then(response => {
        const status = response.sources?.[sourceKey]
        if (status) setServerStatus({ enabled: status.enabled })
      }).catch(() => {})
    }
  }, [apiEndpoint, sourceKey])

  const updateCredentialsMutation = useMutation({
    mutationFn: (creds: Record<string, string>) => 
      api.updateIntegrationCredentials(sourceKey, creds),
    onSuccess: () => {
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
      queryClient.invalidateQueries({ queryKey: ['integration-status'] })
    },
  })

  const testMutation = useMutation({
    mutationFn: () => api.testIntegration(sourceKey),
  })

  const toggleEnabled = async (enabled: boolean) => {
    setServerStatus(prev => ({ ...prev, loading: true }))
    try {
      const response = enabled 
        ? await api.enableSource(sourceKey)
        : await api.disableSource(sourceKey)
      setServerStatus({ enabled: response.enabled, loading: false })
    } catch {
      setServerStatus(prev => ({ ...prev, loading: false }))
    }
  }

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard.writeText(text)
    setCopiedUrl(id)
    setTimeout(() => setCopiedUrl(null), 2000)
  }

  const webhookBaseUrl = apiEndpoint ? `${apiEndpoint}webhooks/` : ''

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50"
      >
        <div className="flex items-center gap-3">
          <span className="text-2xl">{info.icon}</span>
          <div className="text-left">
            <span className="font-medium">{info.name}</span>
            {info.description && (
              <p className="text-xs text-gray-500">{info.description}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          {sourceStatus?.configured && (
            <span className="text-xs text-green-600 flex items-center gap-1">
              <CheckCircle2 size={14} /> Connected
            </span>
          )}
          <label className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
            {serverStatus.loading ? (
              <Loader2 size={16} className="animate-spin text-blue-600" />
            ) : (
              <input
                type="checkbox"
                checked={serverStatus.enabled}
                onChange={(e) => toggleEnabled(e.target.checked)}
                disabled={!apiEndpoint}
                className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
            )}
            <span className="text-sm text-gray-600">Enabled</span>
          </label>
          <span className={clsx(
            'w-2 h-2 rounded-full',
            serverStatus.enabled ? 'bg-green-500' : 'bg-gray-300'
          )} />
        </div>
      </button>

      {/* Expanded content */}
      {isExpanded && (
        <div className="border-t border-gray-200 p-4 bg-gray-50 space-y-6">
          {/* Webhooks */}
          {info.webhooks && info.webhooks.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Webhook size={16} /> Webhook Endpoints
              </h4>
              <div className="space-y-3">
                {info.webhooks.map((webhook, idx) => (
                  <div key={idx} className="bg-white rounded-lg p-3 border border-gray-200">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-gray-700">{webhook.name}</span>
                      {webhook.docUrl && (
                        <a href={webhook.docUrl} target="_blank" rel="noopener noreferrer" 
                           className="text-blue-600 hover:text-blue-700 text-xs flex items-center gap-1">
                          Documentation <ExternalLink size={12} />
                        </a>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <code className="flex-1 bg-gray-50 border border-gray-200 rounded px-3 py-2 text-sm font-mono text-gray-800 truncate">
                        {webhookBaseUrl}{sourceKey}
                      </code>
                      <button
                        onClick={() => copyToClipboard(`${webhookBaseUrl}${sourceKey}`, `webhook-${idx}`)}
                        className="btn btn-secondary p-2"
                        title="Copy URL"
                      >
                        {copiedUrl === `webhook-${idx}` ? <Check size={16} className="text-green-600" /> : <Copy size={16} />}
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">Events: {webhook.events}</p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Credentials */}
          {info.fields.length > 0 && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2">
                <Key size={16} /> API Credentials
              </h4>
              <div className="space-y-3">
                {info.fields.map(field => (
                  <div key={field.key}>
                    <label className="block text-xs text-gray-500 mb-1">{field.label}</label>
                    {field.multiline ? (
                      <textarea
                        value={credentials[field.key] || ''}
                        onChange={(e) => setCredentials(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                        className="input min-h-[60px] text-sm"
                      />
                    ) : (
                      <input
                        type={field.type === 'password' && !showSecrets ? 'password' : 'text'}
                        value={credentials[field.key] || ''}
                        onChange={(e) => setCredentials(prev => ({ ...prev, [field.key]: e.target.value }))}
                        placeholder={field.placeholder}
                        className="input text-sm"
                      />
                    )}
                  </div>
                ))}

                {/* Current status */}
                {sourceStatus?.credentials_set && (
                  <div className="p-3 bg-white rounded-lg border border-gray-200">
                    <p className="text-xs font-medium text-gray-700 mb-2">Configured in Secrets Manager:</p>
                    <div className="flex flex-wrap gap-2">
                      {info.fields.map(field => (
                        <span key={field.key} className={clsx(
                          'px-2 py-1 rounded text-xs',
                          sourceStatus.credentials_set?.includes(field.key)
                            ? 'bg-green-100 text-green-700'
                            : 'bg-gray-200 text-gray-500'
                        )}>
                          {field.label} {sourceStatus.credentials_set?.includes(field.key) ? '✓' : '✗'}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => setShowSecrets(!showSecrets)}
                    className="btn btn-secondary flex items-center gap-2 text-sm"
                  >
                    {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
                    {showSecrets ? 'Hide' : 'Show'}
                  </button>
                  <button
                    onClick={() => updateCredentialsMutation.mutate(credentials)}
                    disabled={updateCredentialsMutation.isPending || Object.keys(credentials).length === 0}
                    className={clsx(
                      'btn flex items-center gap-2 text-sm',
                      saveSuccess ? 'bg-green-600 text-white' : 'btn-primary'
                    )}
                  >
                    {updateCredentialsMutation.isPending ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : saveSuccess ? (
                      <Check size={14} />
                    ) : (
                      <Save size={14} />
                    )}
                    {saveSuccess ? 'Saved!' : 'Save to Secrets Manager'}
                  </button>
                  <button
                    onClick={() => testMutation.mutate()}
                    disabled={testMutation.isPending || !sourceStatus?.configured}
                    className="btn btn-secondary flex items-center gap-2 text-sm"
                  >
                    {testMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
                    Test
                  </button>
                </div>

                {testMutation.data && (
                  <div className={clsx(
                    'p-3 rounded-lg text-sm',
                    testMutation.data.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
                  )}>
                    {testMutation.data.success ? <CheckCircle2 size={14} className="inline mr-2" /> : <AlertCircle size={14} className="inline mr-2" />}
                    {testMutation.data.message}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Setup instructions */}
          {info.setupInstructions && (
            <div className={clsx(
              'p-3 rounded-lg text-sm',
              info.setupInstructions.color === 'blue' ? 'bg-blue-50 border border-blue-200' :
              info.setupInstructions.color === 'orange' ? 'bg-orange-50 border border-orange-200' :
              'bg-gray-50 border border-gray-200'
            )}>
              <h5 className={clsx(
                'font-semibold mb-2',
                info.setupInstructions.color === 'blue' ? 'text-blue-900' :
                info.setupInstructions.color === 'orange' ? 'text-orange-900' : 'text-gray-900'
              )}>{info.setupInstructions.title}</h5>
              <ol className={clsx(
                'list-decimal list-inside space-y-1 text-xs',
                info.setupInstructions.color === 'blue' ? 'text-blue-800' :
                info.setupInstructions.color === 'orange' ? 'text-orange-800' : 'text-gray-700'
              )}>
                {info.setupInstructions.steps.map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </div>
          )}
        </div>
      )}
    </div>
  )
}


export default function Settings() {
  const queryClient = useQueryClient()
  const { config, setConfig } = useConfigStore()
  const [saved, setSaved] = useState(false)
  const [saving, setSaving] = useState(false)
  
  // Local state for form
  const [apiEndpoint, setApiEndpoint] = useState(config.apiEndpoint)
  const [brandName, setBrandName] = useState(config.brandName)
  const [brandHandles, setBrandHandles] = useState(config.brandHandles.join(', '))
  const [hashtags, setHashtags] = useState(config.hashtags.join(', '))
  const [urlsToTrack, setUrlsToTrack] = useState(config.urlsToTrack.join('\n'))

  // Load brand settings from backend on mount
  const { data: backendSettings, isLoading: loadingSettings } = useQuery({
    queryKey: ['brand-settings'],
    queryFn: () => api.getBrandSettings(),
    enabled: !!config.apiEndpoint,
  })

  // Sync backend settings to local state when loaded
  useEffect(() => {
    if (backendSettings && !backendSettings.error) {
      setBrandName(backendSettings.brand_name || '')
      setBrandHandles(backendSettings.brand_handles?.join(', ') || '')
      setHashtags(backendSettings.hashtags?.join(', ') || '')
      setUrlsToTrack(backendSettings.urls_to_track?.join('\n') || '')
      // Also update the store
      setConfig({
        brandName: backendSettings.brand_name || '',
        brandHandles: backendSettings.brand_handles || [],
        hashtags: backendSettings.hashtags || [],
        urlsToTrack: backendSettings.urls_to_track || [],
      })
    }
  }, [backendSettings, setConfig])

  const handleSave = async () => {
    const brandHandlesArray = brandHandles.split(',').map(h => h.trim()).filter(Boolean)
    const hashtagsArray = hashtags.split(',').map(h => h.trim()).filter(Boolean)
    const urlsArray = urlsToTrack.split('\n').map(u => u.trim()).filter(Boolean)

    // Update local store (for API endpoint which stays local)
    setConfig({
      apiEndpoint,
      brandName,
      brandHandles: brandHandlesArray,
      hashtags: hashtagsArray,
      urlsToTrack: urlsArray,
      sources: config.sources,
    })

    // Save brand settings to backend if API is configured
    if (apiEndpoint) {
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
        console.error('Failed to save brand settings to backend:', err)
      } finally {
        setSaving(false)
      }
    }

    setSaved(true)
    setTimeout(() => setSaved(false), 3000)
  }

  return (
    <div className="max-w-4xl mx-auto space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="text-gray-500">Configure your VoC data lake, data sources, and integrations</p>
        </div>
        <button
          onClick={handleSave}
          disabled={saving}
          className={clsx(
            'btn flex items-center gap-2',
            saved ? 'bg-green-600 text-white' : 'btn-primary',
            saving && 'opacity-75 cursor-not-allowed'
          )}
        >
          {saving ? (
            <Loader2 size={18} className="animate-spin" />
          ) : saved ? (
            <Check size={18} />
          ) : (
            <Save size={18} />
          )}
          {saving ? 'Saving...' : saved ? 'Saved!' : 'Save Changes'}
        </button>
      </div>

      {/* API Configuration */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-4">API Configuration</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              API Endpoint URL
            </label>
            <input
              type="url"
              value={apiEndpoint}
              onChange={(e) => setApiEndpoint(e.target.value)}
              placeholder="https://your-api-id.execute-api.region.amazonaws.com/v1"
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              The API Gateway endpoint from your VoC deployment
            </p>
          </div>
        </div>
      </div>

      {/* Brand Configuration */}
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Brand Configuration</h2>
          {apiEndpoint && (
            <span className="text-xs text-green-600 flex items-center gap-1">
              <CheckCircle2 size={14} /> Synced to backend
            </span>
          )}
        </div>
        {loadingSettings && apiEndpoint && (
          <div className="flex items-center gap-2 text-sm text-gray-500 mb-4">
            <Loader2 size={16} className="animate-spin" />
            Loading settings from server...
          </div>
        )}
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Brand Name
            </label>
            <input
              type="text"
              value={brandName}
              onChange={(e) => setBrandName(e.target.value)}
              placeholder="Your Brand Name"
              className="input"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Brand Handles (comma-separated)
            </label>
            <input
              type="text"
              value={brandHandles}
              onChange={(e) => setBrandHandles(e.target.value)}
              placeholder="@yourbrand, yourbrand, YourBrand"
              className="input"
            />
            <p className="text-xs text-gray-500 mt-1">
              Social media handles and variations to track
            </p>
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Hashtags to Track (comma-separated)
            </label>
            <input
              type="text"
              value={hashtags}
              onChange={(e) => setHashtags(e.target.value)}
              placeholder="#yourbrand, #yourproduct"
              className="input"
            />
          </div>
          
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              URLs to Track (one per line)
            </label>
            <textarea
              value={urlsToTrack}
              onChange={(e) => setUrlsToTrack(e.target.value)}
              placeholder="https://example.com/reviews&#10;https://forum.example.com"
              className="input min-h-[100px]"
            />
            <p className="text-xs text-gray-500 mt-1">
              Specific URLs to monitor via web search
            </p>
          </div>
        </div>
      </div>

      {/* Categories Configuration */}
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <Tags className="text-purple-600" size={20} />
          <h2 className="text-lg font-semibold">Feedback Categories</h2>
        </div>
        <p className="text-sm text-gray-500 mb-4">
          Configure categories and subcategories for feedback classification. These are used by the AI processor to categorize incoming feedback.
        </p>
        {!apiEndpoint ? (
          <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>Configure the API endpoint above to manage categories.</span>
          </div>
        ) : (
          <CategoriesManager />
        )}
      </div>

      {/* Data Sources & Integrations */}
      <div className="card">
        <h2 className="text-lg font-semibold mb-2">Data Sources & Integrations</h2>
        <p className="text-sm text-gray-500 mb-4">
          Configure API credentials, webhooks, and enable/disable data source schedules.
        </p>
        {!apiEndpoint && (
          <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg mb-4">
            <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
            <span>Configure the API endpoint above to manage data sources.</span>
          </div>
        )}
        
        <div className="space-y-3">
          {Object.entries(sourceInfo).map(([key, info]) => (
            <SourceCard 
              key={key} 
              sourceKey={key} 
              info={info} 
              apiEndpoint={apiEndpoint} 
            />
          ))}
        </div>
      </div>

      {/* Danger zone */}
      <div className="card border-red-200">
        <h2 className="text-lg font-semibold text-red-600 mb-4">Danger Zone</h2>
        <div className="flex items-center justify-between">
          <div>
            <p className="font-medium text-gray-900">Reset all settings</p>
            <p className="text-sm text-gray-500">Clear all configuration and start fresh</p>
          </div>
          <button
            onClick={() => {
              if (confirm('Are you sure? This will clear all your settings.')) {
                localStorage.removeItem('voc-config')
                window.location.reload()
              }
            }}
            className="btn bg-red-100 text-red-700 hover:bg-red-200"
          >
            Reset
          </button>
        </div>
      </div>
    </div>
  )
}
