/**
 * @fileoverview Source card component for Settings page.
 * @module pages/Settings/SourceCard
 * 
 * Renders a data source configuration card based on plugin manifest.
 */

import type React from 'react'
import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Save, Check, AlertCircle, Loader2, Copy, ExternalLink, Eye, EyeOff, CheckCircle2, Webhook, Key, TestTube } from 'lucide-react'
import { api } from '../../api/client'
import S3ImportExplorer from '../../components/S3ImportExplorer'
import clsx from 'clsx'
import type { PluginManifest, ConfigField, SetupInfo, WebhookInfo } from '../../plugins/types'

// ============================================
// Props Types
// ============================================

interface SourceCardProps {
  readonly manifest: PluginManifest
  readonly apiEndpoint: string
}

// ============================================
// Helper Functions
// ============================================

function getInstructionColors(color: string): { bg: string; border: string; title: string; text: string } {
  if (color === 'blue') return { bg: 'bg-blue-50', border: 'border-blue-200', title: 'text-blue-900', text: 'text-blue-800' }
  if (color === 'orange') return { bg: 'bg-orange-50', border: 'border-orange-200', title: 'text-orange-900', text: 'text-orange-800' }
  if (color === 'green') return { bg: 'bg-green-50', border: 'border-green-200', title: 'text-green-900', text: 'text-green-800' }
  return { bg: 'bg-gray-50', border: 'border-gray-200', title: 'text-gray-900', text: 'text-gray-700' }
}

function getSaveButtonIcon(isPending: boolean, saveSuccess: boolean): React.ReactElement {
  if (isPending) return <Loader2 size={14} className="animate-spin" />
  if (saveSuccess) return <Check size={14} />
  return <Save size={14} />
}

function getSaveButtonText(saveSuccess: boolean): { full: string; short: string } {
  if (saveSuccess) return { full: 'Saved!', short: 'Saved!' }
  return { full: 'Save to Secrets Manager', short: 'Save' }
}

// ============================================
// Main Component
// ============================================

export default function SourceCard({ manifest, apiEndpoint }: SourceCardProps) {
  const queryClient = useQueryClient()
  const [isExpanded, setIsExpanded] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null)
  const [serverStatus, setServerStatus] = useState<{ enabled: boolean; loading?: boolean }>({ enabled: false })

  const { data: integrationStatus } = useQuery({
    queryKey: ['integration-status'],
    queryFn: () => api.getIntegrationStatus(),
    enabled: !!apiEndpoint,
  })

  const sourceStatus = integrationStatus?.[manifest.id]

  useEffect(() => {
    if (apiEndpoint) {
      api.getSourcesStatus().then(response => {
        const status = response.sources?.[manifest.id]
        if (status) setServerStatus({ enabled: status.enabled })
      }).catch(() => {})
    }
  }, [apiEndpoint, manifest.id])

  const updateCredentialsMutation = useMutation({
    mutationFn: (creds: Record<string, string>) => api.updateIntegrationCredentials(manifest.id, creds),
    onSuccess: () => {
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
      queryClient.invalidateQueries({ queryKey: ['integration-status'] })
    },
  })

  const testMutation = useMutation({
    mutationFn: () => api.testIntegration(manifest.id),
  })

  const toggleEnabled = async (enabled: boolean) => {
    setServerStatus(prev => ({ ...prev, loading: true }))
    try {
      const response = enabled ? await api.enableSource(manifest.id) : await api.disableSource(manifest.id)
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
      <SourceCardHeader
        manifest={manifest}
        sourceStatus={sourceStatus}
        serverStatus={serverStatus}
        apiEndpoint={apiEndpoint}
        isExpanded={isExpanded}
        onToggleExpand={() => setIsExpanded(!isExpanded)}
        onToggleEnabled={toggleEnabled}
      />

      {isExpanded && (
        <div className="p-3 sm:p-4 border-t border-gray-200 space-y-4 sm:space-y-6">
          {manifest.webhooks && manifest.webhooks.length > 0 && (
            <WebhooksSection
              webhooks={manifest.webhooks}
              sourceKey={manifest.id}
              webhookBaseUrl={webhookBaseUrl}
              copiedUrl={copiedUrl}
              onCopy={copyToClipboard}
            />
          )}

          {manifest.config.length > 0 && (
            <CredentialsSection
              fields={manifest.config}
              credentials={credentials}
              showSecrets={showSecrets}
              sourceStatus={sourceStatus}
              saveSuccess={saveSuccess}
              testMutation={testMutation}
              updateCredentialsMutation={updateCredentialsMutation}
              onCredentialsChange={setCredentials}
              onToggleSecrets={() => setShowSecrets(!showSecrets)}
            />
          )}

          {manifest.setup && (
            <SetupInstructionsSection setup={manifest.setup} />
          )}

          {manifest.id === 's3_import' && apiEndpoint && (
            <div>
              <h4 className="text-sm font-semibold text-gray-700 mb-2 sm:mb-3 flex items-center gap-2">
                📁 File Explorer
              </h4>
              <S3ImportExplorer />
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================
// Sub-Components
// ============================================

interface SourceCardHeaderProps {
  readonly manifest: PluginManifest
  readonly sourceStatus: { configured?: boolean } | undefined
  readonly serverStatus: { enabled: boolean; loading?: boolean }
  readonly apiEndpoint: string
  readonly isExpanded: boolean
  readonly onToggleExpand: () => void
  readonly onToggleEnabled: (enabled: boolean) => void
}

function SourceCardHeader({ manifest, sourceStatus, serverStatus, apiEndpoint, isExpanded, onToggleExpand, onToggleEnabled }: SourceCardHeaderProps) {
  return (
    <button
      onClick={onToggleExpand}
      className="w-full flex flex-col sm:flex-row sm:items-center justify-between p-3 sm:p-4 hover:bg-gray-50 gap-2 sm:gap-3"
    >
      <div className="flex items-center gap-2 sm:gap-3">
        <span className="text-xl sm:text-2xl">{manifest.icon}</span>
        <div className="text-left min-w-0">
          <span className="font-medium text-sm sm:text-base">{manifest.name}</span>
          {manifest.description && <p className="text-xs text-gray-500 line-clamp-1">{manifest.description}</p>}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-3 ml-auto sm:ml-0">
        {sourceStatus?.configured && (
          <span className="text-xs text-green-600 flex items-center gap-1">
            <CheckCircle2 size={14} /> <span className="hidden xs:inline">Connected</span>
          </span>
        )}
        <label className="flex items-center gap-1.5 sm:gap-2" onClick={(e) => e.stopPropagation()}>
          {serverStatus.loading ? (
            <Loader2 size={16} className="animate-spin text-blue-600" />
          ) : (
            <input
              type="checkbox"
              checked={serverStatus.enabled}
              onChange={(e) => onToggleEnabled(e.target.checked)}
              disabled={!apiEndpoint}
              className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
            />
          )}
          <span className="text-xs sm:text-sm text-gray-600">{serverStatus.enabled ? 'Enabled' : 'Disabled'}</span>
        </label>
        <svg className={clsx('w-4 h-4 sm:w-5 sm:h-5 text-gray-400 transition-transform', isExpanded && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </button>
  )
}

interface WebhooksSectionProps {
  readonly webhooks: WebhookInfo[]
  readonly sourceKey: string
  readonly webhookBaseUrl: string
  readonly copiedUrl: string | null
  readonly onCopy: (text: string, id: string) => void
}

function WebhooksSection({ webhooks, sourceKey, webhookBaseUrl, copiedUrl, onCopy }: WebhooksSectionProps) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-2 sm:mb-3 flex items-center gap-2">
        <Webhook size={16} /> Webhooks
      </h4>
      <div className="space-y-2 sm:space-y-3">
        {webhooks.map((webhook, idx) => {
          const webhookUrl = `${webhookBaseUrl}${sourceKey}`
          const webhookId = `${sourceKey}-${idx}`
          return (
            <div key={idx} className="bg-gray-50 p-2 sm:p-3 rounded-lg">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <span className="font-medium text-xs sm:text-sm">{webhook.name}</span>
                {webhook.docUrl && (
                  <a href={webhook.docUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                    <ExternalLink size={12} /> Docs
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs bg-white px-2 py-1.5 rounded border border-gray-200 overflow-x-auto">{webhookUrl}</code>
                <button onClick={() => onCopy(webhookUrl, webhookId)} className="btn btn-secondary p-1.5 sm:p-2 flex-shrink-0">
                  {copiedUrl === webhookId ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
                </button>
              </div>
              <p className="text-xs text-gray-500 mt-1.5 sm:mt-2">Events: {webhook.events.join(', ')}</p>
            </div>
          )
        })}
      </div>
    </div>
  )
}

interface CredentialsSectionProps {
  readonly fields: ConfigField[]
  readonly credentials: Record<string, string>
  readonly showSecrets: boolean
  readonly sourceStatus: { configured?: boolean } | undefined
  readonly saveSuccess: boolean
  readonly testMutation: { isPending: boolean; data?: { success: boolean; message?: string; error?: string }; mutate: () => void }
  readonly updateCredentialsMutation: { isPending: boolean; mutate: (creds: Record<string, string>) => void }
  readonly onCredentialsChange: (creds: Record<string, string>) => void
  readonly onToggleSecrets: () => void
}

function CredentialsSection({
  fields, credentials, showSecrets, sourceStatus, saveSuccess, testMutation, updateCredentialsMutation,
  onCredentialsChange, onToggleSecrets
}: CredentialsSectionProps) {
  const saveIcon = getSaveButtonIcon(updateCredentialsMutation.isPending, saveSuccess)
  const saveText = getSaveButtonText(saveSuccess)
  const saveButtonClass = saveSuccess ? 'bg-green-600 text-white' : 'btn-primary'

  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-2 sm:mb-3 flex items-center gap-2">
        <Key size={16} /> API Credentials
      </h4>
      <div className="space-y-3 sm:space-y-4">
        <div className="grid gap-3 sm:gap-4">
          {fields.map((field) => (
            <CredentialField
              key={field.key}
              field={field}
              value={credentials[field.key] ?? ''}
              showSecrets={showSecrets}
              onChange={(value) => onCredentialsChange({ ...credentials, [field.key]: value })}
            />
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button onClick={onToggleSecrets} className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2">
            {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
            {showSecrets ? 'Hide' : 'Show'}
          </button>
          <button
            onClick={() => updateCredentialsMutation.mutate(credentials)}
            disabled={updateCredentialsMutation.isPending || Object.keys(credentials).length === 0}
            className={clsx('btn flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2', saveButtonClass)}
          >
            {saveIcon}
            <span className="hidden xs:inline">{saveText.full}</span>
            <span className="xs:hidden">{saveText.short}</span>
          </button>
          <button
            onClick={() => testMutation.mutate()}
            disabled={testMutation.isPending || !sourceStatus?.configured}
            className="btn btn-secondary flex items-center gap-1.5 sm:gap-2 text-xs sm:text-sm px-2 sm:px-3 py-1.5 sm:py-2"
          >
            {testMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
            Test
          </button>
        </div>

        {testMutation.data && (
          <TestResultMessage success={testMutation.data.success} message={testMutation.data.message || testMutation.data.error || 'Unknown result'} />
        )}
      </div>
    </div>
  )
}

interface CredentialFieldProps {
  readonly field: ConfigField
  readonly value: string
  readonly showSecrets: boolean
  readonly onChange: (value: string) => void
}

function CredentialField({ field, value, showSecrets, onChange }: CredentialFieldProps) {
  const placeholder = field.placeholder ?? `Enter ${field.label.toLowerCase()}`
  const inputType = field.type === 'password' && !showSecrets ? 'password' : 'text'

  if (field.type === 'textarea') {
    return (
      <div>
        <label className="block text-xs sm:text-sm font-medium text-gray-600 mb-1">
          {field.label}
          {field.required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input text-xs sm:text-sm min-h-[80px]"
        />
      </div>
    )
  }

  if (field.type === 'select' && field.options) {
    return (
      <div>
        <label className="block text-xs sm:text-sm font-medium text-gray-600 mb-1">
          {field.label}
          {field.required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input text-xs sm:text-sm"
        >
          <option value="">Select...</option>
          {field.options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    )
  }

  return (
    <div>
      <label className="block text-xs sm:text-sm font-medium text-gray-600 mb-1">
        {field.label}
        {field.required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input text-xs sm:text-sm"
      />
    </div>
  )
}

interface TestResultMessageProps {
  readonly success: boolean
  readonly message: string
}

function TestResultMessage({ success, message }: TestResultMessageProps) {
  const bgClass = success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
  const Icon = success ? CheckCircle2 : AlertCircle
  return (
    <div className={clsx('p-2 sm:p-3 rounded-lg text-xs sm:text-sm', bgClass)}>
      <Icon size={14} className="inline mr-1.5 sm:mr-2" />
      {message}
    </div>
  )
}

interface SetupInstructionsSectionProps {
  readonly setup: SetupInfo
}

function SetupInstructionsSection({ setup }: SetupInstructionsSectionProps) {
  const colors = getInstructionColors(setup.color ?? 'blue')

  return (
    <div className={clsx('p-2 sm:p-3 rounded-lg text-xs sm:text-sm border', colors.bg, colors.border)}>
      <h5 className={clsx('font-semibold mb-2', colors.title)}>{setup.title}</h5>
      <ol className={clsx('list-decimal list-inside space-y-1 text-xs', colors.text)}>
        {setup.steps.map((step, i) => <li key={i}>{step}</li>)}
      </ol>
    </div>
  )
}
