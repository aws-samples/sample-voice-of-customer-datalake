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
import { FlaskConical, Loader2, Sparkles } from 'lucide-react'
import {
  useId, useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import {
  PluginFieldGrid, SetupInstructions, ResultMessage,
} from './PluginConfigParts'
import type { PluginManifest } from '../../plugins/types'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceDialogHeader from './SourceDialogHeader'

interface GeneratorConfigModalProps {
  readonly plugin: PluginManifest
  readonly onClose: () => void
  /** Whether the current user is an admin. The credentials endpoint is
   *  admin-gated server-side; this flag prevents a 403 for non-admin users.
   *  REQUIRED, not optional-with-default: a caller that forgot it would silently
   *  get the non-admin path, i.e. a Generate button disabled for an admin. */
  readonly isAdmin: boolean
}

type RunPhase = 'idle' | 'running' | 'completed' | 'error'

const TERMINAL_STATUSES = new Set(['completed', 'error', 'failed'])
const POLL_INTERVAL_MS = 2000

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
      <div className="flex items-center gap-2 text-sm text-aim bg-aim-subtle rounded-lg p-3">
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
  plugin, onClose, isAdmin,
}: GeneratorConfigModalProps) {
  const { t } = useTranslation('scrapers')
  const titleId = useId()
  const fieldKeys = plugin.config.map((f) => f.key)

  const [edits, setEdits] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<RunPhase>('idle')
  const [itemsFound, setItemsFound] = useState(0)

  // GET /integrations/<source>/credentials is admin-gated server-side; only
  // issue the query for admin users to prevent a 403 for regular users.
  const { data: savedConfig } = useQuery({
    queryKey: ['generator-config', plugin.id],
    queryFn: () => api.getIntegrationCredentials(plugin.id, fieldKeys),
    enabled: isAdmin,
  })

  // Derive form values from saved config + local edits (no init effect needed).
  const values: Record<string, string> = {
    ...savedConfig,
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
    // Escape / backdrop are off while a run is in flight, so a stray key does not
    // drop the progress view mid-run; Close and the X remain the deliberate exits.
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} dismissable={!isBusy} panelClassName="max-w-2xl max-h-[95vh] sm:max-h-[90vh]">
        <SourceDialogHeader titleId={titleId} title={plugin.name} description={plugin.description} icon={FlaskConical} tone="aim" onClose={onClose} />

        <div className="dialog-body space-y-4">
          <PluginFieldGrid
            fields={plugin.config}
            values={values}
            onChange={(key, v) => setEdits((prev) => ({
              ...prev,
              [key]: v,
            }))}
          />

          <RunStatusBanner
            phase={phase}
            runningNote={runningNote}
            completedMsg={t('generator.completed', { count: itemsFound })}
            errorMsg={t('generator.startFailed')}
          />

          {plugin.setup == null ? null : <SetupInstructions setup={plugin.setup} />}
        </div>

        {/* Secondary first, primary last (right) — the order every other dialog uses. */}
        <div className="dialog-footer">
          <button type="button" onClick={onClose} className="btn btn-secondary">{t('pluginConfig.close')}</button>
          <button
            type="button"
            onClick={() => generateMutation.mutate()}
            disabled={isBusy || !hasRequired || !isAdmin}
            title={isAdmin ? undefined : ADMIN_ONLY_TITLE}
            className="btn btn-primary"
          >
            {isBusy ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            {isBusy ? t('generator.generating') : t('generator.generate')}
          </button>
        </div>
    </ModalShell>
  )
}
