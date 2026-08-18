/**
 * @fileoverview Manifest-driven config + run modal for on-demand "generator" plugins
 * (e.g. the Synthetic Data Review Generator).
 * @module pages/Scrapers/GeneratorConfigModal
 *
 * Renders the plugin's config[] fields generically, saves them via
 * /integrations/{id}/credentials, triggers a run via /sources/{id}/run, and polls
 * run status. There is no plugin-specific UI — everything is driven by the manifest.
 */

import {
  useMutation, useQuery,
} from '@tanstack/react-query'
import {
  Loader2, Sparkles,
} from 'lucide-react'
import {
  useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import {
  PluginField, SetupInstructions, ResultMessage,
} from './PluginConfigParts'
import type { PluginManifest } from '../../plugins/types'

interface GeneratorConfigModalProps {
  readonly plugin: PluginManifest
  readonly onClose: () => void
}

type RunPhase = 'idle' | 'running' | 'completed' | 'error'

const TERMINAL_STATUSES = new Set(['completed', 'error', 'failed'])
const POLL_INTERVAL_MS = 2000

function GeneratorHeader({
  plugin, onClose,
}: {
  readonly plugin: PluginManifest;
  readonly onClose: () => void
}) {
  const hasDescription = plugin.description != null && plugin.description !== ''
  return (
    <div className="p-4 border-b flex items-center justify-between">
      <div className="flex items-center gap-3">
        <span className="w-10 h-10 rounded-lg bg-indigo-100 text-indigo-600 flex items-center justify-center text-xl flex-shrink-0">{plugin.icon.slice(0, 2)}</span>
        <div>
          <h3 className="font-semibold text-lg">{plugin.name}</h3>
          {hasDescription ? <p className="text-sm text-gray-500">{plugin.description}</p> : null}
        </div>
      </div>
      <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
    </div>
  )
}

function RunStatusBanner({
  phase, runningNote, completedMsg, errorMsg,
}: {
  readonly phase: RunPhase
  readonly runningNote: string
  readonly completedMsg: string
  readonly errorMsg: string
}) {
  if (phase === 'running') {
    return (
      <div className="flex items-center gap-2 text-sm text-indigo-700 bg-indigo-50 rounded-lg p-3">
        <Loader2 size={16} className="animate-spin" />
        <span>{runningNote}</span>
      </div>
    )
  }
  if (phase === 'completed') return <ResultMessage success message={completedMsg} />
  if (phase === 'error') return <ResultMessage success={false} message={errorMsg} />
  return null
}

export default function GeneratorConfigModal({
  plugin, onClose,
}: GeneratorConfigModalProps) {
  const { t } = useTranslation('scrapers')
  const fieldKeys = plugin.config.map((f) => f.key)

  const [edits, setEdits] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<RunPhase>('idle')
  const [itemsFound, setItemsFound] = useState(0)

  const { data: savedConfig } = useQuery({
    queryKey: ['generator-config', plugin.id],
    queryFn: () => api.getIntegrationCredentials(plugin.id, fieldKeys),
  })

  // Derive form values from saved config + local edits (no init effect needed).
  const values: Record<string, string> = {
    ...(savedConfig ?? {}),
    ...edits,
  }

  useEffect(() => {
    if (phase !== 'running') return
    const poll = () => {
      void api.getSourceRunStatus(plugin.id)
        .then((res) => {
          setItemsFound(res.items_found ?? 0)
          if (TERMINAL_STATUSES.has(res.status)) {
            setPhase(res.status === 'completed' ? 'completed' : 'error')
          }
          return null
        })
        .catch(() => null)
    }
    const interval = setInterval(poll, POLL_INTERVAL_MS)
    return () => clearInterval(interval)
  }, [phase, plugin.id])

  const generateMutation = useMutation({
    mutationFn: async () => {
      await api.updateIntegrationCredentials(plugin.id, values)
      return await api.runSource(plugin.id)
    },
    onSuccess: () => {
      setItemsFound(0)
      setPhase('running')
    },
    onError: () => setPhase('error'),
  })

  const hasRequired = plugin.config
    .filter((f) => f.required === true)
    .every((f) => (values[f.key] ?? '').trim() !== '')
  const isBusy = generateMutation.isPending || phase === 'running'
  const runningNote = itemsFound > 0
    ? `${t('generator.runningNote')} (${itemsFound})`
    : t('generator.runningNote')

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col">
        <GeneratorHeader plugin={plugin} onClose={onClose} />

        <div className="p-4 overflow-y-auto flex-1 space-y-4">
          <div className="grid gap-3">
            {plugin.config.map((field) => (
              <PluginField
                key={field.key}
                field={field}
                value={values[field.key] ?? ''}
                showSecrets={false}
                onChange={(v) => setEdits((prev) => ({
                  ...prev,
                  [field.key]: v,
                }))}
              />
            ))}
          </div>

          <RunStatusBanner
            phase={phase}
            runningNote={runningNote}
            completedMsg={t('generator.completed', { count: itemsFound })}
            errorMsg={t('generator.startFailed')}
          />

          {plugin.setup == null ? null : <SetupInstructions setup={plugin.setup} />}
        </div>

        <div className="p-4 border-t flex items-center gap-2">
          <button
            onClick={() => generateMutation.mutate()}
            disabled={isBusy || !hasRequired}
            className="btn btn-primary flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {isBusy ? t('generator.generating') : t('generator.generate')}
          </button>
          <button onClick={onClose} className="btn btn-secondary text-sm ml-auto">{t('pluginConfig.close')}</button>
        </div>
      </div>
    </div>
  )
}
