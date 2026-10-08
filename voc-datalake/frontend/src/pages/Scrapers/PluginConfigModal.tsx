/**
 * @fileoverview Plugin configuration modal for the Scrapers page.
 * @module pages/Scrapers/PluginConfigModal
 *
 * Supports multiple app configurations per plugin (e.g. track 2 iOS apps).
 * Configs are stored as a JSON array in Secrets Manager via the
 * /integrations/{source}/apps CRUD endpoints.
 */

import {
  useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import { Save, Loader2, Play, AlertCircle, CheckCircle2, Plus, Trash2, Pencil, Smartphone } from 'lucide-react'
import { manifestIcon } from '../../components/SourceIcon/sourceIcons'
import {
  useId, useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import {
  SetupInstructions, PluginFieldGrid,
} from './PluginConfigParts'
import { appField, getAppIdentifier, ownValue, supportsAppConfigs } from './scraper-helpers'
import type { AppConfig } from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceDialogHeader from './SourceDialogHeader'

interface PluginConfigModalProps {
  readonly plugin: PluginManifest
  readonly onClose: () => void
  /** Whether the current user is an admin.
   *
   *  Every mutating route this modal calls — POST/DELETE `/integrations/{source}/apps`,
   *  `POST /sources/{source}/run`, `PUT /sources/{source}/enable|disable` — is
   *  admin-gated server-side. They were not, which is why this prop is new: a
   *  `users`-group caller could write the shared secret and invoke an ingestor.
   *  Disabling the controls is presentation only; the gate that matters is the
   *  server's, and this exists so a non-admin sees why rather than a silent 403. */
  readonly isAdmin: boolean
}


function ResultMessage({
  success, message,
}: {
  readonly success: boolean;
  readonly message: string
}) {
  const Icon = success ? CheckCircle2 : AlertCircle
  return (
    <div className={clsx('p-3 rounded-lg text-sm', success ? 'bg-ok-subtle text-ok' : 'bg-danger-subtle text-danger')}>
      <Icon size={14} className="inline mr-2" />{message}
    </div>
  )
}

function ScheduleToggle({
  scheduleLoading, scheduleEnabled, isAdmin, onToggle,
}: {
  readonly scheduleLoading: boolean
  readonly scheduleEnabled: boolean
  readonly isAdmin: boolean
  readonly onToggle: (enabled: boolean) => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="flex items-center justify-between p-3 bg-bg-accent rounded-lg">
      <div>
        <p className="text-sm font-medium">{t('pluginConfig.automaticSchedule')}</p>
        <p className="text-xs text-muted">{t('pluginConfig.scheduleDescription')}</p>
      </div>
      {scheduleLoading ? <Loader2 size={16} className="animate-spin text-accent" /> : (
        <label className={clsx('flex items-center gap-2', isAdmin ? 'cursor-pointer' : 'cursor-not-allowed')} title={isAdmin ? undefined : ADMIN_ONLY_TITLE}>
          <input type="checkbox" checked={scheduleEnabled} disabled={!isAdmin} onChange={(e) => onToggle(e.target.checked)} className="rounded-sm accent-accent focus-ring disabled:opacity-50" />
          <span className="text-sm text-text">{scheduleEnabled ? t('pluginConfig.enabled') : t('pluginConfig.disabled')}</span>
        </label>
      )}
    </div>
  )
}

function AppCard({
  app, pluginId, isAdmin, onEdit, onDelete,
}: {
  readonly app: AppConfig;
  readonly pluginId: string;
  readonly isAdmin: boolean;
  readonly onEdit: () => void;
  readonly onDelete: () => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="flex items-center justify-between gap-2 p-3 border border-border rounded-lg">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-lg bg-accent-subtle text-accent-text flex items-center justify-center flex-shrink-0"><Smartphone size={18} /></div>
        <div className="min-w-0">
          <p className="text-sm font-medium text-text-strong truncate">{app.app_name === '' ? t('appCard.unnamed') : app.app_name}</p>
          <p className="text-xs text-muted font-mono truncate">{getAppIdentifier(app, pluginId)}</p>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* Edit stays enabled for everyone: it only opens the form. The SAVE inside
            it is what writes, and that is disabled below — so a non-admin can read
            an app's settings without being handed a button that 403s. */}
        <button type="button" onClick={onEdit} className="icon-btn p-2" aria-label={t('card.edit')} title={t('card.edit')}><Pencil size={16} /></button>
        <button type="button" onClick={onDelete} disabled={!isAdmin} aria-label={t('card.delete')} title={isAdmin ? t('card.delete') : ADMIN_ONLY_TITLE} className="icon-btn p-2 hover:text-danger hover:bg-danger-subtle disabled:opacity-40 disabled:cursor-not-allowed"><Trash2 size={16} /></button>
      </div>
    </div>
  )
}

function AppEditorForm({
  plugin, initialValues, isAdmin, onSave, onCancel, isPending,
}: {
  readonly plugin: PluginManifest;
  readonly initialValues: AppConfig;
  readonly isAdmin: boolean;
  readonly onSave: (v: AppConfig) => void;
  readonly onCancel: () => void;
  readonly isPending: boolean
}) {
  const { t } = useTranslation('scrapers')
  const [values, setValues] = useState<AppConfig>(initialValues)
  const isEditing = appField(initialValues, 'id') !== ''
  const hasRequired = plugin.config.filter((f) => f.required === true).every((f) => appField(values, f.key).trim() !== '')

  return (
    <div className="space-y-4 p-4 border border-accent/30 bg-accent-subtle rounded-lg">
      <h3 className="text-sm font-semibold text-text-strong">{isEditing ? t('appCard.editApp') : t('appCard.addNewApp')}</h3>
      <PluginFieldGrid
        fields={plugin.config}
        values={values}
        onChange={(key, v) => setValues((prev) => ({
          ...prev,
          [key]: v,
        }))}
      />
      <div className="flex items-center gap-2">
        <button onClick={() => onSave({ ...values })} disabled={isPending || !hasRequired || !isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-primary">
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {isEditing ? t('pluginConfig.save') : t('appCard.addApp')}
        </button>
        <button type="button" onClick={onCancel} className="btn btn-secondary">{t('editor.cancel')}</button>
      </div>
    </div>
  )
}

function AppListSection({
  plugin, apps, appsLoading, showEditor, editorInitialValues, savePending, isAdmin, onStartAdd, onStartEdit, onDelete, onSaveApp, onCancelEditor,
}: {
  readonly plugin: PluginManifest;
  readonly apps: AppConfig[];
  readonly appsLoading: boolean;
  readonly showEditor: boolean
  readonly editorInitialValues: AppConfig;
  readonly savePending: boolean
  readonly isAdmin: boolean
  readonly onStartAdd: () => void;
  readonly onStartEdit: (app: AppConfig) => void;
  readonly onDelete: (id: string) => void
  readonly onSaveApp: (v: AppConfig) => void;
  readonly onCancelEditor: () => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-strong">{t('appCard.configuredApps')}</h3>
        {!showEditor && <button type="button" onClick={onStartAdd} disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-secondary btn-sm"><Plus size={14} /> {t('appCard.addApp')}</button>}
      </div>
      {appsLoading ? <div className="flex items-center justify-center py-6"><Loader2 className="animate-spin h-6 w-6 text-accent" /></div> : null}
      {!appsLoading && apps.length === 0 && !showEditor && (
        <div className="text-center py-6 text-sm border border-dashed border-border rounded-lg">
          <Smartphone size={20} className="mx-auto mb-2 text-muted" aria-hidden="true" />
          <p className="text-muted">{t('appCard.noApps')}</p>
          {/* Not rendered at all for a non-admin, rather than rendered disabled: it
              is a prompt to do something they cannot do, and the empty state has no
              other content to anchor a disabled control to. */}
          {isAdmin ? <button type="button" onClick={onStartAdd} className="btn btn-primary btn-sm mt-3"><Plus size={14} /> {t('appCard.addFirstApp')}</button> : null}
        </div>
      )}
      {!appsLoading && apps.length > 0 && (
        <div className="space-y-2">
          {apps.map((app) => <AppCard key={appField(app, 'id')} app={app} pluginId={plugin.id} isAdmin={isAdmin} onEdit={() => onStartEdit(app)} onDelete={() => onDelete(appField(app, 'id'))} />)}
        </div>
      )}
      {showEditor ? <AppEditorForm plugin={plugin} initialValues={editorInitialValues} isAdmin={isAdmin} onSave={onSaveApp} onCancel={onCancelEditor} isPending={savePending} /> : null}
    </div>
  )
}

/**
 * For a plugin without app configs (S3 import, GitHub Issues): its settings are
 * the shared credentials edited under Settings → Data sources, so point there
 * instead of offering an app editor whose save the API refuses.
 */
function SettingsPointer() {
  const { t } = useTranslation('scrapers')
  return (
    <p className="text-sm text-muted">
      {t('pluginConfig.configuredInSettings')}{' '}
      <Link to="/admin?tab=plugins" className="link">{t('pluginConfig.openDataSourceSettings')}</Link>
    </p>
  )
}

function RunNowRow({
  isAdmin, isPending, result, onRun,
}: {
  readonly isAdmin: boolean
  readonly isPending: boolean
  readonly result: { success: boolean; message: string } | undefined
  readonly onRun: () => void
}) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="flex items-center gap-2">
      <button onClick={onRun} disabled={isPending || !isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-secondary">
        {isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
        {t('pluginConfig.runNow')}
      </button>
      {result == null ? null : <ResultMessage success={result.success} message={result.message === '' ? t('pluginConfig.runTriggered') : result.message} />}
    </div>
  )
}

export default function PluginConfigModal({
  plugin, onClose, isAdmin,
}: PluginConfigModalProps) {
  const { t } = useTranslation('scrapers')
  const titleId = useId()
  const queryClient = useQueryClient()
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleLoading, setScheduleLoading] = useState(true)
  const [editingApp, setEditingApp] = useState<AppConfig | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [deleteAppId, setDeleteAppId] = useState<string | null>(null)

  // `/integrations/{source}/apps` serves only the app-review plugins (400 for any other).
  const hasApps = supportsAppConfigs(plugin.id)
  const {
    data: appConfigsData, isLoading: appsLoading,
  } = useQuery({
    queryKey: ['app-configs', plugin.id],
    queryFn: () => api.getAppConfigs(plugin.id),
    enabled: hasApps,
  })
  const apps = appConfigsData?.apps ?? []

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await api.getSourcesStatus([plugin.id])
        const status = ownValue(response.sources, plugin.id)
        if (status != null) setScheduleEnabled(status.enabled)
      } catch {
        // ignored — schedule status is non-critical
      } finally {
        setScheduleLoading(false)
      }
    }
    void fetchStatus()
  }, [plugin.id])

  const saveMutation = useMutation({
    mutationFn: (app: AppConfig) => api.saveAppConfig(plugin.id, app),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['app-configs', plugin.id] })
      void queryClient.invalidateQueries({ queryKey: ['all-app-configs'] })
      setEditingApp(null)
      setIsAdding(false)
    },
  })
  const deleteMutation = useMutation({
    mutationFn: (appId: string) => api.deleteAppConfig(plugin.id, appId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['app-configs', plugin.id] })
      void queryClient.invalidateQueries({ queryKey: ['all-app-configs'] })
      setDeleteAppId(null)
    },
  })
  const runMutation = useMutation({ mutationFn: () => api.runSource(plugin.id) })

  const handleToggleSchedule = async (enabled: boolean) => {
    setScheduleLoading(true)
    try {
      const response = enabled ? await api.enableSource(plugin.id) : await api.disableSource(plugin.id)
      setScheduleEnabled(response.enabled)
    } catch {
      // ignored — toggle failure is non-critical
    }
    setScheduleLoading(false)
  }

  const showEditor = isAdding || editingApp !== null

  return (
    // Escape / backdrop close only when no app form is open — a half-filled
    // app config would otherwise be lost to a stray key.
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} dismissable={!showEditor} panelClassName="max-w-2xl max-h-[95vh] sm:max-h-[90vh]">
        <SourceDialogHeader titleId={titleId} title={plugin.name} description={plugin.description} icon={manifestIcon(plugin.icon, plugin.category)} tone="accent" onClose={onClose} />
        <div className="dialog-body space-y-5">
          <ScheduleToggle scheduleLoading={scheduleLoading} scheduleEnabled={scheduleEnabled} isAdmin={isAdmin} onToggle={(e) => void handleToggleSchedule(e)} />
          {hasApps ? (
            <AppListSection plugin={plugin} apps={apps} appsLoading={appsLoading} showEditor={showEditor} editorInitialValues={editingApp ?? {}} savePending={saveMutation.isPending} isAdmin={isAdmin}
              onStartAdd={() => {
                setEditingApp(null); setIsAdding(true)
              }} onStartEdit={(app) => {
                setIsAdding(false); setEditingApp(app)
              }}
              onDelete={(id) => setDeleteAppId(id)} onSaveApp={(v) => saveMutation.mutate(v)} onCancelEditor={() => {
                setEditingApp(null); setIsAdding(false)
              }} />
          ) : <SettingsPointer />}
          {apps.length > 0 && <RunNowRow isAdmin={isAdmin} isPending={runMutation.isPending} result={runMutation.data} onRun={() => runMutation.mutate()} />}
          {plugin.setup == null ? null : <SetupInstructions setup={plugin.setup} />}
        </div>
        <div className="dialog-footer">
          <button type="button" onClick={onClose} className="btn btn-secondary">{t('pluginConfig.close')}</button>
        </div>
      {deleteAppId == null || deleteAppId === '' ? null : <ConfirmModal isOpen title={t('appCard.deleteConfirmTitle')} message={t('appCard.deleteConfirmMessage')} confirmLabel={t('deleteConfirmLabel')} onConfirm={() => {
        deleteMutation.mutate(deleteAppId)
      }} onCancel={() => setDeleteAppId(null)} />}
    </ModalShell>
  )
}
