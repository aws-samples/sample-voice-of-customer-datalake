/**
 * @fileoverview Plugin configuration modal for the Scrapers page.
 * @module pages/Scrapers/PluginConfigModal
 *
 * Allows configuring and enabling auto-discovered plugins (e.g. iOS/Android app reviews)
 * directly from the Scrapers page, reusing the same integrations API as Settings.
 */

import {
  useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import {
  Save, Check, Loader2, Eye, EyeOff, TestTube, Play,
} from 'lucide-react'
import {
  useState, useEffect, useRef,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import {
  PluginField, SetupInstructions, ResultMessage,
} from './PluginConfigParts'
import type { PluginManifest } from '../../plugins/types'

interface PluginConfigModalProps {
  readonly plugin: PluginManifest
  readonly onClose: () => void
}

export default function PluginConfigModal({
  plugin, onClose,
}: PluginConfigModalProps) {
  const { t } = useTranslation('scrapers')
  const queryClient = useQueryClient()
  const [credentials, setCredentials] = useState<Record<string, string>>({})
  const [showSecrets, setShowSecrets] = useState(false)
  const [saveSuccess, setSaveSuccess] = useState(false)
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleLoading, setScheduleLoading] = useState(true)
  const hasFetchedCredentials = useRef(false)

  // Fetch existing credentials
  const { data: fetchedCredentials } = useQuery({
    queryKey: ['integration-credentials', plugin.id],
    queryFn: () => api.getIntegrationCredentials(plugin.id, plugin.config.map((f) => f.key)),
    enabled: plugin.config.length > 0,
  })

  // Merge fetched credentials into local state on initial fetch
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

  // Fetch schedule status
  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await api.getSourcesStatus([plugin.id])
        const status = response.sources[plugin.id]
        setScheduleEnabled(status.enabled)
      } catch {
        /* ignore */
      } finally {
        setScheduleLoading(false)
      }
    }
    void fetchStatus()
  }, [plugin.id])

  const saveMutation = useMutation({
    mutationFn: (creds: Record<string, string>) => api.updateIntegrationCredentials(plugin.id, creds),
    onSuccess: () => {
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
      hasFetchedCredentials.current = false
      void queryClient.invalidateQueries({ queryKey: ['integration-status'] })
      void queryClient.invalidateQueries({ queryKey: ['integration-credentials', plugin.id] })
    },
  })

  const testMutation = useMutation({ mutationFn: () => api.testIntegration(plugin.id) })

  const runMutation = useMutation({ mutationFn: () => api.runSource(plugin.id) })

  const handleToggleSchedule = async (enabled: boolean) => {
    setScheduleLoading(true)
    try {
      const response = enabled ? await api.enableSource(plugin.id) : await api.disableSource(plugin.id)
      setScheduleEnabled(response.enabled)
    } catch {
      /* ignore */
    }
    setScheduleLoading(false)
  }

  const handleSave = () => {
    const completeCreds: Record<string, string> = {}
    for (const field of plugin.config) {
      const current = field.key in credentials ? credentials[field.key] : undefined
      if (current != null && current !== '') {
        completeCreds[field.key] = current
      } else if (field.options && field.options.length > 0) {
        completeCreds[field.key] = field.options[0].value
      } else if (field.placeholder != null && field.placeholder !== '') {
        completeCreds[field.key] = field.placeholder
      }
    }
    saveMutation.mutate(completeCreds)
  }

  function getSaveIcon() {
    if (saveMutation.isPending) return <Loader2 size={14} className="animate-spin" />
    if (saveSuccess) return <Check size={14} />
    return <Save size={14} />
  }

  const saveIcon = getSaveIcon()

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <PluginModalHeader plugin={plugin} onClose={onClose} />

        {/* Body */}
        <div className="p-4 overflow-y-auto flex-1 space-y-5">
          <ScheduleToggle
            scheduleLoading={scheduleLoading}
            scheduleEnabled={scheduleEnabled}
            onToggle={(enabled) => void handleToggleSchedule(enabled)}
          />

          {plugin.config.length > 0 && (
            <PluginConfigSection
              plugin={plugin}
              credentials={credentials}
              showSecrets={showSecrets}
              saveSuccess={saveSuccess}
              saveIcon={saveIcon}
              saveMutation={saveMutation}
              testMutation={testMutation}
              runMutation={runMutation}
              onCredentialsChange={setCredentials}
              onToggleSecrets={() => setShowSecrets(!showSecrets)}
              onSave={handleSave}
            />
          )}

          {plugin.setup ? <SetupInstructions setup={plugin.setup} /> : null}
        </div>

        {/* Footer */}
        <div className="p-4 border-t">
          <button onClick={onClose} className="btn btn-secondary w-full text-sm">{t('pluginConfig.close')}</button>
        </div>
      </div>
    </div>
  )
}

function PluginModalHeader({
  plugin, onClose,
}: {
  readonly plugin: PluginManifest;
  readonly onClose: () => void
}) {
  return (
    <div className="p-4 border-b flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center text-[10px] font-semibold overflow-hidden truncate px-1">
          {plugin.icon.slice(0, 8)}
        </span>
        <div>
          <h3 className="font-semibold text-lg">{plugin.name}</h3>
          {plugin.description != null && plugin.description !== '' ? <p className="text-sm text-gray-500">{plugin.description}</p> : null}
        </div>
      </div>
      <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
    </div>
  )
}

function ScheduleToggle({
  scheduleLoading, scheduleEnabled, onToggle,
}: {
  readonly scheduleLoading: boolean
  readonly scheduleEnabled: boolean
  readonly onToggle: (enabled: boolean) => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
      <div>
        <p className="text-sm font-medium">{t('pluginConfig.automaticSchedule')}</p>
        <p className="text-xs text-gray-500">{t('pluginConfig.scheduleDescription')}</p>
      </div>
      {scheduleLoading ? (
        <Loader2 size={16} className="animate-spin text-blue-600" />
      ) : (
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={scheduleEnabled}
            onChange={(e) => onToggle(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-600">{scheduleEnabled ? t('pluginConfig.enabled') : t('pluginConfig.disabled')}</span>
        </label>
      )}
    </div>
  )
}

interface PluginConfigSectionProps {
  readonly plugin: PluginManifest
  readonly credentials: Record<string, string>
  readonly showSecrets: boolean
  readonly saveSuccess: boolean
  readonly saveIcon: React.ReactElement
  readonly saveMutation: { isPending: boolean }
  readonly testMutation: {
    isPending: boolean;
    data?: {
      success: boolean;
      message?: string;
      error?: string
    };
    mutate: () => void
  }
  readonly runMutation: {
    isPending: boolean;
    data?: {
      success: boolean;
      message?: string
    };
    mutate: () => void
  }
  readonly onCredentialsChange: (creds: Record<string, string>) => void
  readonly onToggleSecrets: () => void
  readonly onSave: () => void
}

function PluginActionButtons({
  showSecrets, saveSuccess, saveIcon, saveMutation, testMutation, runMutation,
  onToggleSecrets, onSave,
}: {
  readonly showSecrets: boolean
  readonly saveSuccess: boolean
  readonly saveIcon: React.ReactElement
  readonly saveMutation: { isPending: boolean }
  readonly testMutation: {
    isPending: boolean;
    mutate: () => void
  }
  readonly runMutation: {
    isPending: boolean;
    mutate: () => void
  }
  readonly onToggleSecrets: () => void
  readonly onSave: () => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button onClick={onToggleSecrets} className="btn btn-secondary flex items-center gap-2 text-sm">
        {showSecrets ? <EyeOff size={14} /> : <Eye size={14} />}
        {showSecrets ? t('pluginConfig.hide') : t('pluginConfig.show')}
      </button>
      <button
        onClick={onSave}
        disabled={saveMutation.isPending}
        className={clsx('btn flex items-center gap-2 text-sm', saveSuccess ? 'bg-green-600 text-white' : 'btn-primary')}
      >
        {saveIcon}
        {saveSuccess ? t('pluginConfig.saved') : t('pluginConfig.save')}
      </button>
      <button
        onClick={() => testMutation.mutate()}
        disabled={testMutation.isPending}
        className="btn btn-secondary flex items-center gap-2 text-sm"
      >
        {testMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <TestTube size={14} />}
        {t('pluginConfig.test')}
      </button>
      <button
        onClick={() => runMutation.mutate()}
        disabled={runMutation.isPending}
        className="btn btn-secondary flex items-center gap-2 text-sm"
      >
        {runMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {t('pluginConfig.runNow')}
      </button>
    </div>
  )
}

function PluginConfigSection({
  plugin, credentials, showSecrets, saveSuccess, saveIcon, saveMutation, testMutation, runMutation,
  onCredentialsChange, onToggleSecrets, onSave,
}: PluginConfigSectionProps) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="space-y-4">
      <h4 className="text-sm font-semibold text-gray-700">{t('pluginConfig.configuration')}</h4>
      <div className="grid gap-4">
        {plugin.config.map((field) => (
          <PluginField
            key={field.key}
            field={field}
            value={credentials[field.key] ?? ''}
            showSecrets={showSecrets}
            onChange={(value) => onCredentialsChange({
              ...credentials,
              [field.key]: value,
            })}
          />
        ))}
      </div>

      <PluginActionButtons
        showSecrets={showSecrets}
        saveSuccess={saveSuccess}
        saveIcon={saveIcon}
        saveMutation={saveMutation}
        testMutation={testMutation}
        runMutation={runMutation}
        onToggleSecrets={onToggleSecrets}
        onSave={onSave}
      />

      {testMutation.data ? <ResultMessage success={testMutation.data.success} message={testMutation.data.message ?? testMutation.data.error ?? 'Unknown result'} /> : null}
      {runMutation.data ? <ResultMessage success={runMutation.data.success} message={runMutation.data.message ?? t('pluginConfig.runTriggered')} /> : null}
    </div>
  )
}
