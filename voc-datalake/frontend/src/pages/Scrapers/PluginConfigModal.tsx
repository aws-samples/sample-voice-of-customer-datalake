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
import {
  Save, Loader2, Play, AlertCircle, CheckCircle2, Plus, Trash2, Pencil, Smartphone,
} from 'lucide-react'
import {
  useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import ConfirmModal from '../../components/ConfirmModal'
import { ADMIN_ONLY_TITLE } from './constants'
import {
  SetupInstructions, PluginField,
} from './PluginConfigParts'
import { getAppIdentifier } from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'

type AppConfig = Record<string, string>

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
    <div className={clsx('p-3 rounded-lg text-sm', success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700')}>
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
    <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
      <div>
        <p className="text-sm font-medium">{t('pluginConfig.automaticSchedule')}</p>
        <p className="text-xs text-gray-500">{t('pluginConfig.scheduleDescription')}</p>
      </div>
      {scheduleLoading ? <Loader2 size={16} className="animate-spin text-blue-600" /> : (
        <label className={clsx('flex items-center gap-2', isAdmin ? 'cursor-pointer' : 'cursor-not-allowed')} title={isAdmin ? undefined : ADMIN_ONLY_TITLE}>
          <input type="checkbox" checked={scheduleEnabled} disabled={!isAdmin} onChange={(e) => onToggle(e.target.checked)} className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50" />
          <span className="text-sm text-gray-600">{scheduleEnabled ? t('pluginConfig.enabled') : t('pluginConfig.disabled')}</span>
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
  return (
    <div className="flex items-center justify-between p-3 border border-gray-200 rounded-lg hover:bg-gray-50">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-lg bg-purple-100 text-purple-600 flex items-center justify-center flex-shrink-0"><Smartphone size={18} /></div>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{app.app_name === '' ? 'Unnamed App' : app.app_name}</p>
          <p className="text-xs text-gray-500 truncate">{getAppIdentifier(app, pluginId)}</p>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* Edit stays enabled for everyone: it only opens the form. The SAVE inside
            it is what writes, and that is disabled below — so a non-admin can read
            an app's settings without being handed a button that 403s. */}
        <button onClick={onEdit} className="p-1.5 hover:bg-gray-200 rounded" title="Edit"><Pencil size={14} className="text-gray-500" /></button>
        <button onClick={onDelete} disabled={!isAdmin} title={isAdmin ? 'Delete' : ADMIN_ONLY_TITLE} className="p-1.5 hover:bg-gray-200 rounded disabled:opacity-50 disabled:cursor-not-allowed"><Trash2 size={14} className="text-red-500" /></button>
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
  const [values, setValues] = useState<AppConfig>(initialValues)
  const isEditing = initialValues.id != null && initialValues.id !== ''
  const hasRequired = plugin.config.filter((f) => f.required === true).every((f) => (values[f.key] ?? '').trim() !== '')

  return (
    <div className="space-y-4 p-4 border border-blue-200 bg-blue-50/30 rounded-lg">
      <h4 className="text-sm font-semibold text-gray-700">{isEditing ? 'Edit App' : 'Add New App'}</h4>
      <div className="grid gap-3">
        {plugin.config.map((field) => (
          <PluginField key={field.key} field={field} value={values[field.key] ?? ''} showSecrets={false} onChange={(v) => setValues((prev) => ({
            ...prev,
            [field.key]: v,
          }))} />
        ))}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => onSave({ ...values })} disabled={isPending || !hasRequired || !isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-primary flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed">
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          {isEditing ? 'Save' : 'Add App'}
        </button>
        <button onClick={onCancel} className="btn btn-secondary text-sm">Cancel</button>
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
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold text-gray-700">Configured Apps</h4>
        {!showEditor && <button onClick={onStartAdd} disabled={!isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-primary flex items-center gap-1.5 text-xs px-3 py-1.5 disabled:opacity-50 disabled:cursor-not-allowed"><Plus size={14} /> Add App</button>}
      </div>
      {appsLoading ? <div className="flex items-center justify-center py-6"><Loader2 className="animate-spin h-6 w-6 text-blue-500" /></div> : null}
      {!appsLoading && apps.length === 0 && !showEditor && (
        <div className="text-center py-6 text-gray-400 text-sm">
          <Smartphone className="mx-auto h-8 w-8 mb-2 opacity-50" />
          <p>No apps configured yet</p>
          {/* Not rendered at all for a non-admin, rather than rendered disabled: it
              is a prompt to do something they cannot do, and the empty state has no
              other content to anchor a disabled control to. */}
          {isAdmin ? <button onClick={onStartAdd} className="text-blue-600 hover:underline text-sm mt-1">Add your first app</button> : null}
        </div>
      )}
      {!appsLoading && apps.length > 0 && (
        <div className="space-y-2">
          {apps.map((app) => <AppCard key={app.id} app={app} pluginId={plugin.id} isAdmin={isAdmin} onEdit={() => onStartEdit(app)} onDelete={() => onDelete(app.id)} />)}
        </div>
      )}
      {showEditor ? <AppEditorForm plugin={plugin} initialValues={editorInitialValues} isAdmin={isAdmin} onSave={onSaveApp} onCancel={onCancelEditor} isPending={savePending} /> : null}
    </div>
  )
}

// eslint-disable-next-line complexity
export default function PluginConfigModal({
  plugin, onClose, isAdmin,
}: PluginConfigModalProps) {
  const { t } = useTranslation('scrapers')
  const queryClient = useQueryClient()
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleLoading, setScheduleLoading] = useState(true)
  const [editingApp, setEditingApp] = useState<AppConfig | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [deleteAppId, setDeleteAppId] = useState<string | null>(null)

  const {
    data: appConfigsData, isLoading: appsLoading,
  } = useQuery({
    queryKey: ['app-configs', plugin.id],
    queryFn: () => api.getAppConfigs(plugin.id),
  })
  const apps = appConfigsData?.apps ?? []

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await api.getSourcesStatus([plugin.id])
        const status = response.sources[plugin.id]
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
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-2 sm:p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[95vh] sm:max-h-[90vh] overflow-hidden flex flex-col">
        <div className="p-4 border-b flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-10 h-10 rounded-lg bg-gray-100 text-gray-600 flex items-center justify-center text-[10px] font-semibold overflow-hidden truncate px-1">{plugin.icon.slice(0, 8)}</span>
            <div>
              <h3 className="font-semibold text-lg">{plugin.name}</h3>
              {plugin.description != null && plugin.description !== '' ? <p className="text-sm text-gray-500">{plugin.description}</p> : null}
            </div>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 text-2xl">&times;</button>
        </div>
        <div className="p-4 overflow-y-auto flex-1 space-y-5">
          <ScheduleToggle scheduleLoading={scheduleLoading} scheduleEnabled={scheduleEnabled} isAdmin={isAdmin} onToggle={(e) => void handleToggleSchedule(e)} />
          <AppListSection plugin={plugin} apps={apps} appsLoading={appsLoading} showEditor={showEditor} editorInitialValues={editingApp ?? {}} savePending={saveMutation.isPending} isAdmin={isAdmin}
            onStartAdd={() => {
              setEditingApp(null); setIsAdding(true)
            }} onStartEdit={(app) => {
              setIsAdding(false); setEditingApp(app)
            }}
            onDelete={(id) => setDeleteAppId(id)} onSaveApp={(v) => saveMutation.mutate(v)} onCancelEditor={() => {
              setEditingApp(null); setIsAdding(false)
            }} />
          {apps.length > 0 && (
            <div className="flex items-center gap-2">
              <button onClick={() => runMutation.mutate()} disabled={runMutation.isPending || !isAdmin} title={isAdmin ? undefined : ADMIN_ONLY_TITLE} className="btn btn-secondary flex items-center gap-2 text-sm disabled:opacity-50 disabled:cursor-not-allowed">
                {runMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
                {t('pluginConfig.runNow')}
              </button>
              {runMutation.data == null ? null : <ResultMessage success={runMutation.data.success} message={runMutation.data.message === '' ? t('pluginConfig.runTriggered') : runMutation.data.message} />}
            </div>
          )}
          {plugin.setup == null ? null : <SetupInstructions setup={plugin.setup} />}
        </div>
        <div className="p-4 border-t">
          <button onClick={onClose} className="btn btn-secondary w-full text-sm">{t('pluginConfig.close')}</button>
        </div>
      </div>
      {deleteAppId == null || deleteAppId === '' ? null : <ConfirmModal isOpen title="Delete App" message="Are you sure you want to remove this app configuration?" confirmLabel="Delete" onConfirm={() => {
        deleteMutation.mutate(deleteAppId)
      }} onCancel={() => setDeleteAppId(null)} />}
    </div>
  )
}
