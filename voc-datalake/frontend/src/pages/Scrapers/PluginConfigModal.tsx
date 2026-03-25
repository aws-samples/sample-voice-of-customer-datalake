/**
 * @fileoverview Plugin configuration modal for the Scrapers page.
 * @module pages/Scrapers/PluginConfigModal
 * 
 * Allows configuring and enabling auto-discovered plugins (e.g. iOS/Android app reviews)
 * directly from the Scrapers page, reusing the same integrations API as Settings.
 */

import { useState, useEffect, useRef } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Save, Check, Loader2, Eye, EyeOff, TestTube, Play, AlertCircle, CheckCircle2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import type { PluginManifest, ConfigField, SetupInfo } from '../../plugins/types'
import clsx from 'clsx'

interface PluginConfigModalProps {
  readonly plugin: PluginManifest
  readonly onClose: () => void
}

function getSetupColors(color: string): { bg: string; border: string; title: string; text: string } {
  if (color === 'blue') return { bg: 'bg-blue-50', border: 'border-blue-200', title: 'text-blue-900', text: 'text-blue-800' }
  if (color === 'green') return { bg: 'bg-green-50', border: 'border-green-200', title: 'text-green-900', text: 'text-green-800' }
  if (color === 'orange') return { bg: 'bg-orange-50', border: 'border-orange-200', title: 'text-orange-900', text: 'text-orange-800' }
  return { bg: 'bg-gray-50', border: 'border-gray-200', title: 'text-gray-900', text: 'text-gray-700' }
}

function PluginField({ field, value, showSecrets, onChange }: {
  readonly field: ConfigField
  readonly value: string
  readonly showSecrets: boolean
  readonly onChange: (value: string) => void
}) {
  const { t } = useTranslation('scrapers')
  const placeholder = field.placeholder ?? `Enter ${field.label.toLowerCase()}`

  if (field.type === 'select' && field.options) {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-600 mb-1">
          {field.label}
          {field.required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <select value={value} onChange={(e) => onChange(e.target.value)} className="input text-sm">
          <option value="">{t('pluginConfig.select')}</option>
          {field.options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
      </div>
    )
  }

  if (field.type === 'textarea') {
    return (
      <div>
        <label className="block text-sm font-medium text-gray-600 mb-1">
          {field.label}
          {field.required && <span className="text-red-500 ml-1">*</span>}
        </label>
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="input text-sm min-h-[80px]"
        />
      </div>
    )
  }

  const inputType = field.type === 'password' && !showSecrets ? 'password' : 'text'

  return (
    <div>
      <label className="block text-sm font-medium text-gray-600 mb-1">
        {field.label}
        {field.required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <input
        type={inputType}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="input text-sm"
      />
    </div>
  )
}

function SetupInstructions({ setup }: { readonly setup: SetupInfo }) {
  const colors = getSetupColors(setup.color ?? 'blue')
  return (
    <div className={clsx('p-3 rounded-lg text-sm border', colors.bg, colors.border)}>
      <h5 className={clsx('font-semibold mb-2', colors.title)}>{setup.title}</h5>
      <ol className={clsx('list-decimal list-inside space-y-1 text-xs', colors.text)}>
        {setup.steps.map((step, i) => <li key={i}>{step}</li>)}
      </ol>
    </div>
  )
}

function ResultMessage({ success, message }: { readonly success: boolean; readonly message: string }) {
  const bgClass = success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'
  const Icon = success ? CheckCircle2 : AlertCircle
  return (
    <div className={clsx('p-3 rounded-lg text-sm', bgClass)}>
      <Icon size={14} className="inline mr-2" />
      {message}
    </div>
  )
}

export default function PluginConfigModal({ plugin, onClose }: PluginConfigModalProps) {
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
    queryFn: () => api.getIntegrationCredentials(plugin.id, plugin.config.map(f => f.key)),
    enabled: plugin.config.length > 0,
  })

  // Merge fetched credentials into local state on initial fetch
  useEffect(() => {
    if (!fetchedCredentials || hasFetchedCredentials.current) return
    hasFetchedCredentials.current = true
    queueMicrotask(() => {
      setCredentials(prev => {
        const merged = { ...prev }
        for (const [key, value] of Object.entries(fetchedCredentials)) {
          if (!merged[key]) merged[key] = value
        }
        return merged
      })
    })
  }, [fetchedCredentials])

  // Fetch schedule status
  useEffect(() => {
    api.getSourcesStatus([plugin.id]).then(response => {
      const status = response.sources?.[plugin.id]
      if (status) setScheduleEnabled(status.enabled)
    }).catch(() => {}).finally(() => setScheduleLoading(false))
  }, [plugin.id])

  const saveMutation = useMutation({
    mutationFn: (creds: Record<string, string>) => api.updateIntegrationCredentials(plugin.id, creds),
    onSuccess: () => {
      setSaveSuccess(true)
      setTimeout(() => setSaveSuccess(false), 3000)
      hasFetchedCredentials.current = false
      queryClient.invalidateQueries({ queryKey: ['integration-status'] })
      queryClient.invalidateQueries({ queryKey: ['integration-credentials', plugin.id] })
    },
  })

  const testMutation = useMutation({
    mutationFn: () => api.testIntegration(plugin.id),
  })

  const runMutation = useMutation({
    mutationFn: () => api.runSource(plugin.id),
  })

  const handleToggleSchedule = async (enabled: boolean) => {
    setScheduleLoading(true)
    try {
      const response = enabled ? await api.enableSource(plugin.id) : await api.disableSource(plugin.id)
      setScheduleEnabled(response.enabled)
    } catch { /* ignore */ }
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
      } else if (field.placeholder) {
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
            onToggle={handleToggleSchedule}
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

          {plugin.setup && <SetupInstructions setup={plugin.setup} />}
        </div>

        {/* Footer */}
        <div className="p-4 border-t">
          <button onClick={onClose} className="btn btn-secondary w-full text-sm">{t('pluginConfig.close')}</button>
        </div>
      </div>
    </div>
  )
}

function PluginModalHeader({ plugin, onClose }: { readonly plugin: PluginManifest; readonly onClose: () => void }) {
  return (
    <div className="p-4 border-b flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center text-[10px] font-semibold overflow-hidden truncate px-1">
          {plugin.icon.slice(0, 8)}
        </span>
        <div>
          <h3 className="font-semibold text-lg">{plugin.name}</h3>
          {plugin.description && <p className="text-sm text-gray-500">{plugin.description}</p>}
        </div>
      </div>
      <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
    </div>
  )
}

function ScheduleToggle({ scheduleLoading, scheduleEnabled, onToggle }: {
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
  readonly testMutation: { isPending: boolean; data?: { success: boolean; message?: string; error?: string }; mutate: () => void }
  readonly runMutation: { isPending: boolean; data?: { success: boolean; message?: string }; mutate: () => void }
  readonly onCredentialsChange: (creds: Record<string, string>) => void
  readonly onToggleSecrets: () => void
  readonly onSave: () => void
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
        {plugin.config.map(field => (
          <PluginField
            key={field.key}
            field={field}
            value={credentials[field.key] ?? ''}
            showSecrets={showSecrets}
            onChange={(value) => onCredentialsChange({ ...credentials, [field.key]: value })}
          />
        ))}
      </div>

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

      {testMutation.data && (
        <ResultMessage success={testMutation.data.success} message={testMutation.data.message || testMutation.data.error || 'Unknown result'} />
      )}
      {runMutation.data && (
        <ResultMessage success={runMutation.data.success} message={runMutation.data.message || t('pluginConfig.runTriggered')} />
      )}
    </div>
  )
}
