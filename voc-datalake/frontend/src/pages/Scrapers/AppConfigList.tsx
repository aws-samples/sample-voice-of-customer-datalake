/**
 * @fileoverview App-review configs of every multi-instance plugin, as run-able cards
 * that poll their run status while a run is in flight.
 * @module pages/Scrapers/AppConfigList
 */

import { useQuery } from '@tanstack/react-query'
import { Loader2 } from 'lucide-react'
import {
  useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { AppConfigCard } from './AppConfigComponents'
import {
  appField, getAppIdentifier, ownValue,
} from './scraper-helpers'
import type { RunStatusInfo } from './AppConfigComponents'
import type { AppConfig } from './scraper-helpers'
import type { PluginManifest } from '../../plugins/types'

export default function AppConfigList({
  plugins, isAdmin, onEditPlugin, onDeleteApp, onRunApp,
}: {
  readonly plugins: PluginManifest[];
  /** `POST /sources/{source}/run` and `DELETE /integrations/{source}/apps/{id}` are
   *  admin-gated server-side, so the Run and Delete controls on each card are
   *  disabled for a non-admin rather than firing a 403. Listing the configs is
   *  deliberately NOT gated — that is why this list still renders for everyone. */
  readonly isAdmin: boolean
  readonly onEditPlugin: (p: PluginManifest) => void
  readonly onDeleteApp: (pluginId: string, appId: string) => void;
  readonly onRunApp: (pluginId: string, appIdentifier: string) => Promise<unknown>
}) {
  const { config } = useConfigStore()
  const [runningApps, setRunningApps] = useState<Set<string>>(new Set())
  const [runStatuses, setRunStatuses] = useState<Record<string, RunStatusInfo>>({})

  // Poll run status for running apps
  useEffect(() => {
    if (runningApps.size === 0) return
    // Extract unique plugin IDs from running app keys
    const runningPluginIds = new Set([...runningApps].map((key) => {
      const [pluginId = ''] = key.split('-')
      return pluginId
    }))
    const updateStatus = (pluginId: string, result: {
      status: string
      items_found?: number
      errors?: string[]
    }) => {
      const statusInfo: RunStatusInfo = {
        status: result.status,
        items_found: result.items_found ?? 0,
        errors: result.errors ?? [],
      }
      // Update all running apps for this plugin with the same status
      setRunStatuses((prev) => {
        const next = { ...prev }
        for (const key of runningApps) {
          if (key.startsWith(`${pluginId}-`)) {
            next[key] = statusInfo
          }
        }
        return next
      })
      if (result.status === 'completed' || result.status === 'error') {
        setRunningApps((prev) => {
          const next = new Set(prev)
          for (const key of prev) {
            if (key.startsWith(`${pluginId}-`)) next.delete(key)
          }
          return next
        })
      }
    }
    const pollStatus = () => {
      for (const pluginId of runningPluginIds) {
        void api.getSourceRunStatus(pluginId)
          .then((result) => {
            updateStatus(pluginId, result)
            return null
          })
          .catch(() => null)
      }
    }
    const interval = setInterval(pollStatus, 2000)
    return () => clearInterval(interval)
  }, [runningApps])

  const handleRun = (pluginId: string, appIdentifier: string) => {
    const appKey = `${pluginId}-${appIdentifier}`
    setRunningApps((prev) => new Set(prev).add(appKey))
    setRunStatuses((prev) => ({
      ...prev,
      [appKey]: {
        status: 'running',
        items_found: 0,
        errors: [],
      },
    }))
    // A failed trigger (403, 404, network) used to be an unhandled rejection
    // and left the card spinning; it now ends the run with an error status.
    onRunApp(pluginId, appIdentifier).catch((err: unknown) => {
      setRunningApps((prev) => {
        const next = new Set(prev)
        next.delete(appKey)
        return next
      })
      setRunStatuses((prev) => ({
        ...prev,
        [appKey]: {
          status: 'error',
          items_found: 0,
          errors: [err instanceof Error ? err.message : String(err)],
        },
      }))
    })
  }

  const {
    data: allAppConfigs, isLoading: isLoadingApps,
  } = useQuery({
    queryKey: ['all-app-configs', plugins.map((p) => p.id).join(',')],
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
        const identifier = getAppIdentifier(app, plugin.id)
        const runKey = `${plugin.id}-${identifier}`
        return (
          <AppConfigCard key={`${plugin.id}-${appId}`} app={app} plugin={plugin} isAdmin={isAdmin}
            onEdit={() => onEditPlugin(plugin)} onDelete={() => onDeleteApp(plugin.id, appId)}
            onRun={() => handleRun(plugin.id, identifier)}
            isRunning={runningApps.has(runKey)}
            runStatus={ownValue(runStatuses, runKey)} />
        )
      })}
    </>
  )
}
