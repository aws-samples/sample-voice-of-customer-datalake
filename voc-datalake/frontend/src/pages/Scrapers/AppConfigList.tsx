/**
 * @fileoverview App-review configs of every multi-instance plugin, as run-able cards. Each card reads its own last
 * run on mount (so a reload still shows the result), and polls its own run while it is in flight (useAppRun.ts).
 * @module pages/Scrapers/AppConfigList
 */

import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { AppConfigCard } from './AppConfigComponents'
import { useRadarBrandLabeler } from './useRadarBrands'
import { appField, getAppIdentifier } from './scraper-helpers'
import { useAppRun } from './useAppRun'
import type { RunStatusInfo } from './AppConfigComponents'
import type { AppConfig } from './scraper-helpers'
import type { SourceRunStatus } from './sourceRunStatus'
import type { PluginManifest } from '../../plugins/types'
import { allAppConfigsKey } from '../../api/queryKeys'

type RunApp = (pluginId: string, appIdentifier: string) => Promise<unknown>

function runStatusInfo(run: SourceRunStatus): RunStatusInfo {
  return {
    status: run.status, items_found: run.items_found ?? 0, errors: run.errors ?? [],
    started_at: run.started_at, completed_at: run.completed_at,
  }
}

/** One card and its own run: `identifier` is what Run now sends as `app_id` and what its status is read by. */
function AppRunCard({
  app, plugin, isAdmin, radarBrandLabel, onEdit, onDelete, onRunApp,
}: Readonly<{
  app: AppConfig
  plugin: PluginManifest
  isAdmin: boolean
  radarBrandLabel: string | undefined
  onEdit: () => void
  onDelete: () => void
  onRunApp: RunApp
}>) {
  const { lastRun, isRunning, start } = useAppRun(plugin.id, getAppIdentifier(app, plugin.id), onRunApp)
  return (
    <AppConfigCard app={app} plugin={plugin} radarBrandLabel={radarBrandLabel} isAdmin={isAdmin}
      onEdit={onEdit} onDelete={onDelete} onRun={() => void start()}
      isRunning={isRunning}
      runStatus={lastRun === null ? undefined : runStatusInfo(lastRun)} />
  )
}

export default function AppConfigList({
  plugins, isAdmin, onEditPlugin, onDeleteApp, onRunApp,
}: {
  readonly plugins: PluginManifest[];
  /** `POST /sources/{source}/run` and `DELETE /integrations/{source}/apps/{id}` are
   *  admin-gated server-side, so the Run and Delete controls on each card are
   *  disabled for a non-admin rather than firing a 403. Listing the configs is
   *  deliberately NOT gated — that is why this list still renders for everyone. */
  readonly isAdmin: boolean
  /** Edit one card: opens that app / review page's own form, not the plugin's whole list. */
  readonly onEditPlugin: (p: PluginManifest, appId: string) => void
  readonly onDeleteApp: (pluginId: string, appId: string) => void;
  /** Starts one app's run (`POST /sources/{source}/run` with its `app_id`); its answer's `execution_id` is polled. */
  readonly onRunApp: RunApp
}) {
  const { config } = useConfigStore()
  const {
    data: allAppConfigs, isLoading: isLoadingApps,
  } = useQuery({
    queryKey: allAppConfigsKey(plugins.map((p) => p.id).join(',')),
    queryFn: async () => {
      const emptyApps: AppConfig[] = []
      const results = await Promise.all(plugins.map(async (plugin) => {
        try {
          const response = await api.getAppConfigs(plugin.id)
          return {
            pluginId: plugin.id,
            apps: response.apps,
          }
        } catch {
          // A plugin whose app-config route is missing or failing (404 in mock dev,
          // or not yet configured) simply contributes no cards: the page degrades
          // to the sources it CAN list instead of logging on every visit.
          return {
            pluginId: plugin.id,
            apps: emptyApps,
          }
        }
      }))
      return results
    },
    enabled: config.apiEndpoint.length > 0 && plugins.length > 0,
  })
  const { t } = useTranslation('scrapers')
  const radarLabel = useRadarBrandLabeler()

  const pluginMap = new Map(plugins.map((p) => [p.id, p]))
  const allApps: Array<{
    app: AppConfig;
    plugin: PluginManifest
  }> = []
  for (const entry of allAppConfigs ?? []) {
    const plugin = pluginMap.get(entry.pluginId)
    if (!plugin) continue
    for (const app of entry.apps) allApps.push({
      app,
      plugin,
    })
  }

  if (isLoadingApps) return (
    <div className="card flex items-center justify-center gap-2 py-8" role="status">
      <Loader2 className="animate-spin text-accent" size={16} />
      <span className="text-sm text-muted">{t('appCard.loading')}</span>
    </div>
  )

  if (allApps.length === 0) return null

  return (
    <>
      {allApps.map(({
        app, plugin,
      }) => {
        const appId = appField(app, 'id')
        return (
          <AppRunCard key={`${plugin.id}-${appId}`} app={app} plugin={plugin} radarBrandLabel={radarLabel(appField(app, 'radar_brand'))}
            isAdmin={isAdmin} onEdit={() => onEditPlugin(plugin, appId)} onDelete={() => onDeleteApp(plugin.id, appId)}
            onRunApp={onRunApp} />
        )
      })}
    </>
  )
}
