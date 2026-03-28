/**
 * @fileoverview Source card component for Settings page.
 * @module pages/Settings/SourceCard
 */

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Check, Loader2, Copy, ExternalLink, CheckCircle2, Webhook,
} from 'lucide-react'
import {
  useState, useEffect, useRef,
} from 'react'
import { api } from '../../api/client'
import S3ImportExplorer from '../../components/S3ImportExplorer'
import { useCopyToClipboard } from '../../hooks/useCopyToClipboard'
import {
  CredentialsSection, SetupInstructionsSection,
} from './SourceCardFields'
import type { CredentialsSectionProps } from './SourceCardFields'
import type {
  PluginManifest, WebhookInfo,
} from '../../plugins/types'

interface SourceCardProps {
  readonly manifest: PluginManifest
  readonly apiEndpoint: string
}

function ExpandedContent({
  manifest, apiEndpoint, webhookBaseUrl, copiedUrl, credentials, showSecrets, saveSuccess, runMutation, updateCredentialsMutation, onCopy, onCredentialsChange,
}: {
  readonly manifest: PluginManifest
  readonly apiEndpoint: string
  readonly webhookBaseUrl: string
  readonly copiedUrl: string | null
  readonly credentials: Record<string, string>
  readonly showSecrets: boolean
  readonly saveSuccess: boolean
  readonly runMutation: CredentialsSectionProps['runMutation']
  readonly updateCredentialsMutation: CredentialsSectionProps['updateCredentialsMutation']
  readonly onCopy: (text: string, id: string) => void
  readonly onCredentialsChange: (creds: Record<string, string>) => void
}) {
  return (
    <div className="p-3 sm:p-4 border-t border-gray-200 space-y-4 sm:space-y-6">
      {manifest.webhooks && manifest.webhooks.length > 0 ? <WebhooksSection webhooks={manifest.webhooks} sourceKey={manifest.id} webhookBaseUrl={webhookBaseUrl} copiedUrl={copiedUrl} onCopy={onCopy} /> : null}
      {manifest.config.length > 0 && (
        <CredentialsSection fields={manifest.config} credentials={credentials} showSecrets={showSecrets} saveSuccess={saveSuccess} runMutation={runMutation} hasIngestor={manifest.hasIngestor} updateCredentialsMutation={updateCredentialsMutation} onCredentialsChange={onCredentialsChange} />
      )}
      {manifest.setup ? <SetupInstructionsSection setup={manifest.setup} /> : null}
      {manifest.id === 's3_import' && apiEndpoint !== '' ? <div>
        <h4 className="text-sm font-semibold text-gray-700 mb-2 sm:mb-3 flex items-center gap-2">📁 File Explorer</h4>
        <S3ImportExplorer />
      </div> : null}
    </div>
  )
}

export default function SourceCard({
  manifest, apiEndpoint,
}: SourceCardProps) {
  const queryClient = useQueryClient()
  const [isExpanded, setIsExpanded] = useState(false)
  const showSecrets = false
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const hasFetchedCredentials = useRef(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const {
    copy, copiedKey: copiedUrl,
  } = useCopyToClipboard()
  const [serverStatus, setServerStatus] = useState<{
    enabled: boolean;
    loading?: boolean
  }>({ enabled: false })

  const { data: integrationStatus } = useQuery({
    queryKey: ['integration-status'],
    queryFn: () => api.getIntegrationStatus(),
    enabled: apiEndpoint !== '',
  })

  const sourceStatus = integrationStatus?.[manifest.id]

  const { data: fetchedCredentials } = useQuery({
    queryKey: ['integration-credentials', manifest.id],
    queryFn: () => api.getIntegrationCredentials(manifest.id, manifest.config.map((f) => f.key)),
    enabled: isExpanded && manifest.config.length > 0,
  })

  useEffect(() => {
    if (!fetchedCredentials || hasFetchedCredentials.current) return
    hasFetchedCredentials.current = true
    queueMicrotask(() => {
      setCredentials((prev) => {
        const merged = { ...prev }
        for (const [key, value] of Object.entries(fetchedCredentials)) {
          if (merged[key] === '') merged[key] = value
        }
        return merged
      })
    })
  }, [fetchedCredentials])

  useEffect(() => {
    if (apiEndpoint !== '') {
      const fetchStatus = async () => {
        try {
          const response = await api.getSourcesStatus([manifest.id])
          const status = response.sources[manifest.id]
          setServerStatus({ enabled: status.enabled })
        } catch {
          /* ignore */
        }
      }
      void fetchStatus()
    }
  }, [apiEndpoint, manifest.id])

  const updateCredentialsMutation = useMutation({
    mutationFn: (creds: Record<string, string>) => api.updateIntegrationCredentials(manifest.id, creds),
    onSuccess: () => {
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
      hasFetchedCredentials.current = false
      void queryClient.invalidateQueries({ queryKey: ['integration-status'] })
      void queryClient.invalidateQueries({ queryKey: ['integration-credentials', manifest.id] })
    },
  })

  const runMutation = useMutation({ mutationFn: () => api.runSource(manifest.id) })

  const toggleEnabled = async (enabled: boolean) => {
    setServerStatus((prev) => ({
      ...prev,
      loading: true,
    }))
    try {
      const response = enabled ? await api.enableSource(manifest.id) : await api.disableSource(manifest.id)
      setServerStatus({
        enabled: response.enabled,
        loading: false,
      })
    } catch {
      setServerStatus((prev) => ({
        ...prev,
        loading: false,
      }))
    }
  }

  const copyToClipboard = (text: string, id: string) => copy(text, id)

  const webhookBaseUrl = apiEndpoint === '' ? '' : `${apiEndpoint}webhooks/`

  return (
    <div className="border border-gray-200 rounded-lg overflow-hidden">
      <SourceCardHeader manifest={manifest} sourceStatus={sourceStatus} serverStatus={serverStatus} apiEndpoint={apiEndpoint} isExpanded={isExpanded} onToggleExpand={() => setIsExpanded(!isExpanded)} onToggleEnabled={(enabled) => void toggleEnabled(enabled)} />
      {isExpanded ? <ExpandedContent manifest={manifest} apiEndpoint={apiEndpoint} webhookBaseUrl={webhookBaseUrl} copiedUrl={copiedUrl} credentials={credentials} showSecrets={showSecrets} saveSuccess={saveSuccess} runMutation={runMutation} updateCredentialsMutation={updateCredentialsMutation} onCopy={copyToClipboard} onCredentialsChange={setCredentials} /> : null}
    </div>
  )
}

function SourceCardHeader({
  manifest, sourceStatus, serverStatus, apiEndpoint, isExpanded, onToggleExpand, onToggleEnabled,
}: {
  readonly manifest: PluginManifest
  readonly sourceStatus: { configured?: boolean } | undefined
  readonly serverStatus: {
    enabled: boolean;
    loading?: boolean
  }
  readonly apiEndpoint: string
  readonly isExpanded: boolean
  readonly onToggleExpand: () => void
  readonly onToggleEnabled: (enabled: boolean) => void
}) {
  return (
    <button onClick={onToggleExpand} className="w-full flex flex-col sm:flex-row sm:items-center justify-between p-3 sm:p-4 hover:bg-gray-50 gap-2 sm:gap-3">
      <div className="flex items-center gap-2 sm:gap-3">
        <span className="w-12 h-12 sm:w-13 sm:h-13 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center text-[10px] font-semibold flex-shrink-0 overflow-hidden truncate px-1">{manifest.icon.slice(0, 8)}</span>
        <div className="text-left min-w-0">
          <span className="font-medium text-sm sm:text-base">{manifest.name}</span>
          {manifest.description != null && manifest.description !== '' ? <p className="text-xs text-gray-500 line-clamp-1">{manifest.description}</p> : null}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-3 ml-auto sm:ml-0">
        {sourceStatus?.configured === true ? <span className="text-xs text-green-600 flex items-center gap-1"><CheckCircle2 size={14} /> <span className="hidden xs:inline">Connected</span></span> : null}
        <span className="flex items-center gap-1.5 sm:gap-2">
          {serverStatus.loading === true ? (
            <Loader2 size={16} className="animate-spin text-blue-600" />
          ) : (
            <input type="checkbox" checked={serverStatus.enabled} onChange={(e) => {
              e.stopPropagation()
              onToggleEnabled(e.target.checked)
            }} onClick={(e) => e.stopPropagation()} disabled={apiEndpoint === ''} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
          )}
          <span className="text-xs sm:text-sm text-gray-600">{serverStatus.enabled ? 'Enabled' : 'Disabled'}</span>
        </span>
        <svg className={clsx('w-4 h-4 sm:w-5 sm:h-5 text-gray-400 transition-transform', isExpanded && 'rotate-180')} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>
    </button>
  )
}

function WebhooksSection({
  webhooks, sourceKey, webhookBaseUrl, copiedUrl, onCopy,
}: {
  readonly webhooks: WebhookInfo[]
  readonly sourceKey: string
  readonly webhookBaseUrl: string
  readonly copiedUrl: string | null
  readonly onCopy: (text: string, id: string) => void
}) {
  return (
    <div>
      <h4 className="text-sm font-semibold text-gray-700 mb-2 sm:mb-3 flex items-center gap-2"><Webhook size={16} /> Webhooks</h4>
      <div className="space-y-2 sm:space-y-3">
        {webhooks.map((webhook) => {
          const webhookUrl = `${webhookBaseUrl}${sourceKey}`
          const webhookId = `${sourceKey}-${webhook.name}`
          return (
            <div key={webhook.name} className="bg-gray-50 p-2 sm:p-3 rounded-lg">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
                <span className="font-medium text-xs sm:text-sm">{webhook.name}</span>
                {webhook.docUrl != null && webhook.docUrl !== '' ? <a href={webhook.docUrl} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-600 hover:underline flex items-center gap-1"><ExternalLink size={12} /> Docs</a> : null}
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
