/**
 * @fileoverview Plugin configuration modal for the Scrapers page.
 * @module pages/Scrapers/PluginConfigModal
 *
 * Supports multiple app configurations per plugin (e.g. track 2 iOS apps), through the
 * /integrations/{source}/apps CRUD endpoints: deployment-wide a JSON array in the shared secret,
 * inside a workspace that workspace's own config row (decision 19). Run now inside a workspace runs
 * only a plugin the workspace enabled; otherwise it says to enable it first (`isPluginNotEnabled`).
 */

import {
  useMutation, useQuery, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import { Loader2, Play, Plus, Trash2, Pencil } from 'lucide-react'
import { manifestIcon } from '../../components/SourceIcon/sourceIcons'
import {
  useId, useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { usePluginCopy } from '../../plugins/pluginCopy'
import { Link } from 'react-router-dom'
import { api } from '../../api/client'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import { useAdminOnlyReason } from '../../hooks/useAdminOnlyReason'
import { SetupInstructions, ResultMessage } from './PluginConfigParts'
import AppEditorForm from './AppEditorForm'
import { appSaveMessage, saveAppFromForm } from './appSave'
import { appField, getAppIdentifier, ownValue, supportsAppConfigs } from './scraper-helpers'
import type { AppConfig } from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'
import ModalShell from '../../components/ModalShell/ModalShell'
import SourceDialogHeader from './SourceDialogHeader'
import { appCopy } from './appCopy'
import { RadarBadge } from './SourceCardParts'
import { BEDROCK_WEB_SEARCH, reviewMethod } from './webReviewMethod'
import { useRadarBrandLabel } from './useRadarBrands'
import { allAppConfigsKey, appConfigsKey } from '../../api/queryKeys'
import { isPluginNotEnabled } from '../../workspace/workspaceRefusals'
import { adminPath } from '../Settings/adminPaths'
import { Tooltip } from '../../components/Tooltip/Tooltip'

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
  /** Opened from one card's Edit: show just that app / review page's form, and close when it is saved or cancelled. */
  readonly focusAppId?: string
  /** Opened from a source tile that presets the new app (the Bedrock web search page's `method`): just the add form,
   *  starting with these values, closed when it is saved or cancelled. */
  readonly addPreset?: AppConfig
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
  const adminOnly = useAdminOnlyReason(isAdmin)
  return (
    <div className="flex items-center justify-between p-3 bg-bg-accent rounded-lg">
      <div>
        <p className="text-sm font-medium">{t('pluginConfig.automaticSchedule')}</p>
        <p className="text-xs text-muted">{t('pluginConfig.scheduleDescription')}</p>
      </div>
      {scheduleLoading ? <Loader2 size={16} className="animate-spin text-accent" /> : (
        <label className={clsx('flex items-center gap-2', isAdmin ? 'cursor-pointer' : 'cursor-not-allowed')}>
          <Tooltip kind="description" content={adminOnly}>
            <input type="checkbox" checked={scheduleEnabled} aria-disabled={isAdmin ? undefined : true}
              onChange={(e) => { if (isAdmin) onToggle(e.target.checked) }}
              className="rounded-sm accent-accent focus-ring aria-disabled:cursor-not-allowed aria-disabled:opacity-50" />
          </Tooltip>
          <span className="text-sm text-text">{scheduleEnabled ? t('pluginConfig.enabled') : t('pluginConfig.disabled')}</span>
        </label>
      )}
    </div>
  )
}

/**
 * The plugin's schedule switch, read from `GET /sources/status`. A plugin without a schedule rule (`exists: false`:
 * its manifest declares no `schedule`, like `s3_import`) shows none: enabling it would only be refused (400).
 */
function ScheduleSection({ pluginId, isAdmin }: Readonly<{ pluginId: string; isAdmin: boolean }>) {
  const [scheduleEnabled, setScheduleEnabled] = useState(false)
  const [scheduleExists, setScheduleExists] = useState(true)
  const [scheduleLoading, setScheduleLoading] = useState(true)

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const response = await api.getSourcesStatus([pluginId])
        const status = ownValue(response.sources, pluginId)
        if (status != null) {
          setScheduleEnabled(status.enabled)
          setScheduleExists(status.exists !== false)
        }
      } catch {
        // ignored — schedule status is non-critical
      } finally {
        setScheduleLoading(false)
      }
    }
    void fetchStatus()
  }, [pluginId])

  const handleToggleSchedule = async (enabled: boolean) => {
    setScheduleLoading(true)
    try {
      const response = enabled ? await api.enableSource(pluginId) : await api.disableSource(pluginId)
      setScheduleEnabled(response.enabled)
    } catch {
      // ignored — toggle failure is non-critical
    }
    setScheduleLoading(false)
  }

  if (!scheduleExists) return null
  return <ScheduleToggle scheduleLoading={scheduleLoading} scheduleEnabled={scheduleEnabled} isAdmin={isAdmin} onToggle={(e) => void handleToggleSchedule(e)} />
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
  const adminOnly = useAdminOnlyReason(isAdmin)
  const copy = appCopy(pluginId)
  const Icon = copy.icon
  const radarBrandLabel = useRadarBrandLabel(appField(app, 'radar_brand'))
  return (
    <div className="flex items-center justify-between gap-2 p-3 border border-border rounded-lg">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-9 h-9 rounded-lg bg-accent-subtle text-accent-text flex items-center justify-center flex-shrink-0"><Icon size={18} aria-hidden="true" /></div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <p className="text-sm font-medium text-text-strong truncate">{app.app_name === '' ? t(copy.unnamed) : app.app_name}</p>
            <RadarBadge brandLabel={radarBrandLabel} />
          </div>
          <p className="text-xs text-muted font-mono truncate">{getAppIdentifier(app, pluginId)}</p>
        </div>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        {/* Edit stays enabled for everyone: it only opens the form. The SAVE inside
            it is what writes, and that is disabled below — so a non-admin can read
            an app's settings without being handed a button that 403s. */}
        <Tooltip kind="label" content={t('card.edit')}>
          <button type="button" onClick={onEdit} className="icon-btn p-2" aria-label={t('card.edit')}><Pencil size={16} /></button>
        </Tooltip>
        <Tooltip kind={isAdmin ? 'label' : 'description'} content={adminOnly ?? t('card.delete')}>
          <button type="button" onClick={isAdmin ? onDelete : undefined} aria-disabled={isAdmin ? undefined : true}
            aria-label={t('card.delete')} className="icon-btn p-2 hover:text-danger hover:bg-danger-subtle">
            <Trash2 size={16} />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

function AppListSection({
  plugin, apps, appsLoading, showEditor, editorInitialValues, savePending, saveError, isAdmin, onStartAdd, onStartEdit, onDelete, onSaveApp, onCancelEditor,
}: {
  readonly plugin: PluginManifest;
  readonly apps: AppConfig[];
  readonly appsLoading: boolean;
  readonly showEditor: boolean
  readonly editorInitialValues: AppConfig;
  readonly savePending: boolean
  readonly saveError: string | null
  readonly isAdmin: boolean
  readonly onStartAdd: () => void;
  readonly onStartEdit: (app: AppConfig) => void;
  readonly onDelete: (id: string) => void
  readonly onSaveApp: (v: AppConfig) => void;
  readonly onCancelEditor: () => void
}) {
  const { t } = useTranslation('scrapers')
  const adminOnly = useAdminOnlyReason(isAdmin)
  const copy = appCopy(plugin.id)
  const EmptyIcon = copy.icon
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-text-strong">{t(copy.list)}</h3>
        {!showEditor && (
          <Tooltip kind="description" content={adminOnly}>
            <button type="button" onClick={isAdmin ? onStartAdd : undefined} aria-disabled={isAdmin ? undefined : true} className="btn btn-secondary btn-sm">
              <Plus size={14} /> {t(copy.add)}
            </button>
          </Tooltip>
        )}
      </div>
      {appsLoading ? <div className="flex items-center justify-center py-6"><Loader2 className="animate-spin h-6 w-6 text-accent" /></div> : null}
      {!appsLoading && apps.length === 0 && !showEditor && (
        <div className="text-center py-6 text-sm border border-dashed border-border rounded-lg">
          <EmptyIcon size={20} className="mx-auto mb-2 text-muted" aria-hidden="true" />
          <p className="text-muted">{t(copy.empty)}</p>
          {/* Not rendered at all for a non-admin, rather than rendered disabled: it
              is a prompt to do something they cannot do, and the empty state has no
              other content to anchor a disabled control to. */}
          {isAdmin ? <button type="button" onClick={onStartAdd} className="btn btn-primary btn-sm mt-3"><Plus size={14} /> {t(copy.addFirst)}</button> : null}
        </div>
      )}
      {!appsLoading && apps.length > 0 && (
        <div className="space-y-2">
          {apps.map((app) => <AppCard key={appField(app, 'id')} app={app} pluginId={plugin.id} isAdmin={isAdmin} onEdit={() => onStartEdit(app)} onDelete={() => onDelete(appField(app, 'id'))} />)}
        </div>
      )}
      {showEditor ? <AppEditorForm plugin={plugin} initialValues={editorInitialValues} isAdmin={isAdmin} onSave={onSaveApp} onCancel={onCancelEditor} isPending={savePending} saveError={saveError} /> : null}
    </div>
  )
}

/**
 * For a plugin without app configs (S3 import, GitHub Issues): its token and
 * settings are entered in Administration, so say where in plain words, with
 * the link, instead of the manifest's setup steps — those are written for the
 * Administration card ("paste the token above") and pointed at a field this
 * dialog does not have (live finding). Only a plugin with a secret field has a
 * token to paste; S3 Bulk Import has a bucket and prefixes, so its copy says
 * "enter its settings" (5.34.00 live finding).
 */
function SettingsPointer({ plugin }: Readonly<{ plugin: PluginManifest }>) {
  const { t } = useTranslation(['scrapers', 'settings'])
  const where = `${t('settings:title')} → ${t('settings:tabs.sources')}`
  const { name } = usePluginCopy()(plugin)
  const copy = plugin.config.some((field) => field.secret === true) ? 'pluginConfig.configuredInSettings' : 'pluginConfig.configuredInSettingsNoToken'
  return (
    <div className="p-3 rounded-lg border border-border bg-bg-accent space-y-2">
      <p className="text-sm text-text">{t(copy, { name, where })}</p>
      <Link to={adminPath({ tab: 'sources', section: null })} className="btn btn-primary btn-sm">{t('pluginConfig.openDataSourceSettings')}</Link>
    </div>
  )
}

function RunNowRow({
  isAdmin, isPending, result, error, onRun,
}: {
  readonly isAdmin: boolean
  readonly isPending: boolean
  readonly result: { success: boolean; message: string } | undefined
  /** The failed run's error: a workspace that has not enabled the plugin is shown as its own reason. */
  readonly error: unknown
  readonly onRun: () => void
}) {
  const { t } = useTranslation('scrapers')
  const adminOnly = useAdminOnlyReason(isAdmin)
  const { t: tCommon } = useTranslation('common')
  // Inside a workspace, Run now runs only a plugin the workspace enabled (PLUGIN_NOT_ENABLED, workspaceRefusals.ts):
  // the reason points to Workspace settings, and the button stays for the run once it is enabled there.
  const notEnabled = isPluginNotEnabled(error)
  return (
    <div className="flex items-center gap-2">
      <Tooltip kind="description" content={adminOnly}>
        <button onClick={isAdmin ? onRun : undefined} disabled={isPending} aria-disabled={isAdmin ? undefined : true} className="btn btn-secondary">
          {isPending ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
          {t('pluginConfig.runNow')}
        </button>
      </Tooltip>
      {notEnabled ? <ResultMessage success={false} message={tCommon('workspaces.errors.pluginNotEnabled')} /> : null}
      {result == null ? null : <ResultMessage success={result.success} message={result.message === '' ? t('pluginConfig.runTriggered') : result.message} />}
    </div>
  )
}

/**
 * A card's Edit opened the dialog for one app: that app, and the dialog's title.
 * A focused edit whose app is gone (deleted elsewhere) falls back to the whole list.
 */
function focusState(apps: readonly AppConfig[], appsLoading: boolean, focusAppId: string | undefined, pluginName: string) {
  const focusedApp = focusAppId === undefined ? undefined : apps.find((app) => appField(app, 'id') === focusAppId)
  const focused = focusAppId !== undefined && (appsLoading || focusedApp !== undefined)
  const focusedName = focusedApp === undefined ? '' : appField(focusedApp, 'app_name')
  return { focused, focusedApp, loading: appsLoading, title: focusedName === '' ? pluginName : focusedName }
}

/**
 * What the dialog focuses on: a card's app (`focusState`), or, opened from a tile that presets the new app (the
 * Bedrock web search page), that new app's form, titled after the tile.
 */
function useDialogFocus(apps: readonly AppConfig[], appsLoading: boolean, focusAppId: string | undefined,
  addPreset: AppConfig | undefined, pluginName: string) {
  const { t } = useTranslation('scrapers')
  const focus = focusState(apps, appsLoading, focusAppId, pluginName)
  if (addPreset === undefined || focusAppId !== undefined) return focus
  const title = reviewMethod(addPreset) === BEDROCK_WEB_SEARCH ? t('sourceMenu.items.webReviewsBedrock.title') : pluginName
  return { focused: true, focusedApp: addPreset, loading: false, title }
}

/** The manifest's setup steps; only app-config plugins show them here (the others are set up in Administration). */
function AppSetup({ plugin }: Readonly<{ plugin: PluginManifest }>) {
  return plugin.setup == null ? null : <SetupInstructions setup={plugin.setup} />
}

function DeleteAppConfirm({ appId, pluginId, onConfirm, onCancel }: Readonly<{
  appId: string | null
  pluginId: string
  onConfirm: (appId: string) => void
  onCancel: () => void
}>) {
  const { t } = useTranslation('scrapers')
  if (appId == null || appId === '') return null
  const copy = appCopy(pluginId)
  return <ConfirmModal isOpen title={t(copy.deleteTitle)} message={t(copy.deleteMessage)} confirmLabel={t('deleteConfirmLabel')} onConfirm={() => onConfirm(appId)} onCancel={onCancel} />
}

/** The one-app form a card's Edit opens; a spinner while the configs load. */
function FocusedAppEditor({ plugin, app, loading, isAdmin, isPending, saveError, onSave, onCancel }: Readonly<{
  plugin: PluginManifest
  app: AppConfig | undefined
  loading: boolean
  isAdmin: boolean
  isPending: boolean
  saveError: string | null
  onSave: (v: AppConfig) => void
  onCancel: () => void
}>) {
  if (loading || app === undefined) return <div className="flex items-center justify-center py-6"><Loader2 className="animate-spin h-6 w-6 text-accent" aria-hidden="true" /></div>
  return <AppEditorForm plugin={plugin} initialValues={app} isAdmin={isAdmin} onSave={onSave} onCancel={onCancel} isPending={isPending} saveError={saveError} />
}

export default function PluginConfigModal({
  plugin, onClose, isAdmin, focusAppId, addPreset,
}: PluginConfigModalProps) {
  const { t } = useTranslation('scrapers')
  const pluginCopy = usePluginCopy()(plugin)
  const titleId = useId()
  const queryClient = useQueryClient()
  const [editingApp, setEditingApp] = useState<AppConfig | null>(null)
  const [isAdding, setIsAdding] = useState(false)
  const [deleteAppId, setDeleteAppId] = useState<string | null>(null)

  // `/integrations/{source}/apps` serves only the app-review plugins (400 for any other).
  const hasApps = supportsAppConfigs(plugin.id)
  const {
    data: appConfigsData, isLoading: appsLoading,
  } = useQuery({
    queryKey: appConfigsKey(plugin.id),
    queryFn: () => api.getAppConfigs(plugin.id),
    enabled: hasApps,
  })
  const apps = appConfigsData?.apps ?? []

  const saveMutation = useMutation({
    // A new app or page is a create: one the workspace already has is a 409, said in the form (appSave.ts).
    mutationFn: (app: AppConfig) => saveAppFromForm(plugin.id, app),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: appConfigsKey(plugin.id) })
      void queryClient.invalidateQueries({ queryKey: allAppConfigsKey() })
      setEditingApp(null)
      setIsAdding(false)
    },
  })
  const deleteMutation = useMutation({
    mutationFn: (appId: string) => api.deleteAppConfig(plugin.id, appId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: appConfigsKey(plugin.id) })
      void queryClient.invalidateQueries({ queryKey: allAppConfigsKey() })
      setDeleteAppId(null)
    },
  })
  const runMutation = useMutation({ mutationFn: () => api.runSource(plugin.id) })

  const showEditor = isAdding || editingApp !== null
  const saveError = appSaveMessage(t, { error: saveMutation.error, sent: saveMutation.variables, apps, pluginId: plugin.id })
  // A preset add is a focused form too: the one new app, closed when saved or cancelled.
  const { focused, focusedApp, loading: focusLoading, title } = useDialogFocus(apps, appsLoading, focusAppId, addPreset, pluginCopy.name)

  return (
    // Escape / backdrop close only when no app form is open — a half-filled
    // app config would otherwise be lost to a stray key.
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} dismissable={!showEditor && !focused} panelClassName="max-w-2xl max-h-[95vh] sm:max-h-[90vh]">
        <SourceDialogHeader titleId={titleId} title={title} description={focused ? undefined : pluginCopy.description} icon={manifestIcon(plugin.icon, plugin.category)} onClose={onClose} />
        {focused ? (
          <div className="dialog-body">
            <FocusedAppEditor plugin={plugin} app={focusedApp} loading={focusLoading} isAdmin={isAdmin}
              isPending={saveMutation.isPending} saveError={saveError} onSave={(v) => saveMutation.mutate(v, { onSuccess: onClose })} onCancel={onClose} />
          </div>
        ) : (
        <div className="dialog-body space-y-5">
          <ScheduleSection pluginId={plugin.id} isAdmin={isAdmin} />
          {hasApps ? (
            <AppListSection plugin={plugin} apps={apps} appsLoading={appsLoading} showEditor={showEditor} editorInitialValues={editingApp ?? {}} savePending={saveMutation.isPending} saveError={saveError} isAdmin={isAdmin}
              onStartAdd={() => {
                saveMutation.reset(); setEditingApp(null); setIsAdding(true)
              }} onStartEdit={(app) => {
                saveMutation.reset(); setIsAdding(false); setEditingApp(app)
              }}
              onDelete={(id) => setDeleteAppId(id)} onSaveApp={(v) => saveMutation.mutate(v)} onCancelEditor={() => {
                saveMutation.reset(); setEditingApp(null); setIsAdding(false)
              }} />
          ) : <SettingsPointer plugin={plugin} />}
          {apps.length > 0 && <RunNowRow isAdmin={isAdmin} isPending={runMutation.isPending} result={runMutation.data} error={runMutation.error} onRun={() => runMutation.mutate()} />}
          {hasApps ? <AppSetup plugin={plugin} /> : null}
        </div>
        )}
        <div className="dialog-footer">
          <button type="button" onClick={onClose} className="btn btn-secondary">{t('pluginConfig.close')}</button>
        </div>
      <DeleteAppConfirm appId={deleteAppId} pluginId={plugin.id} onConfirm={(id) => deleteMutation.mutate(id)} onCancel={() => setDeleteAppId(null)} />
    </ModalShell>
  )
}
