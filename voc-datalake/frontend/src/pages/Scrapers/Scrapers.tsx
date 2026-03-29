/**
 * @fileoverview Web scraper configuration page.
 * @module pages/Scrapers
 */

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import {
  Plus, Globe, AlertCircle, Loader2, RefreshCw,
} from 'lucide-react'
import {
  useState, useEffect,
} from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { scrapersApi } from '../../api/scrapersApi'
import ConfirmModal from '../../components/ConfirmModal'
import { getPluginManifests } from '../../plugins'
import { useConfigStore } from '../../store/configStore'
import { useManualImportStore } from '../../store/manualImportStore'
import {
  AppConfigCard, getAppIdentifier,
} from './AppConfigComponents'
import JsonUploadModal from './JsonUploadModal'
import ManualImportModal from './ManualImportModal'
import PluginConfigModal from './PluginConfigModal'
import ScraperCard from './ScraperCard'
import ScraperEditor from './ScraperEditor'
import TemplateSelector from './TemplateSelector'
import type { RunStatusInfo } from './AppConfigComponents'
import type {
  ScraperConfig, ScraperTemplate,
} from '../../api/types'
import type { PluginManifest } from '../../plugins/types'

type AppConfig = Record<string, string>

function getAppConfigPlugins(): PluginManifest[] {
  return getPluginManifests().filter((p) => p.id !== 'webscraper' && p.id !== 's3_import' && p.hasIngestor)
}

function AppConfigList({
  plugins, onEditPlugin, onDeleteApp, onRunApp,
}: {
  readonly plugins: PluginManifest[];
  readonly onEditPlugin: (p: PluginManifest) => void
  readonly onDeleteApp: (pluginId: string, appId: string) => void;
  readonly onRunApp: (pluginId: string, appIdentifier: string) => void
}) {
  const { config } = useConfigStore()
  const [runningPlugins, setRunningPlugins] = useState<Set<string>>(new Set())
  const [runStatuses, setRunStatuses] = useState<Record<string, RunStatusInfo>>({})

  // Poll run status for running plugins
  useEffect(() => {
    if (runningPlugins.size === 0) return
    const updateStatus = (pluginId: string, result: {
      status: string
      items_found?: number
      errors?: string[]
    }) => {
      setRunStatuses((prev) => ({
        ...prev,
        [pluginId]: {
          status: result.status,
          items_found: result.items_found ?? 0,
          errors: result.errors ?? [],
        },
      }))
      if (result.status === 'completed' || result.status === 'error') {
        setRunningPlugins((prev) => {
          const next = new Set(prev)
          next.delete(pluginId)
          return next
        })
      }
    }
    const pollStatus = () => {
      for (const pluginId of runningPlugins) {
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
  }, [runningPlugins])

  const handleRun = (pluginId: string, appIdentifier: string) => {
    setRunningPlugins((prev) => new Set(prev).add(pluginId))
    setRunStatuses((prev) => ({
      ...prev,
      [pluginId]: {
        status: 'running',
        items_found: 0,
        errors: [],
      },
    }))
    onRunApp(pluginId, appIdentifier)
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
        } catch (err) {
          console.warn(`Failed to fetch app configs for plugin "${plugin.id}":`, err)
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
    <div className="card border-2 border-purple-200 bg-purple-50/30 flex items-center justify-center py-8">
      <Loader2 className="animate-spin text-purple-400 mr-2" size={20} />
      <span className="text-sm text-purple-500">Loading app configurations…</span>
    </div>
  )

  if (allApps.length === 0) return null

  return (
    <>
      {allApps.map(({
        app, plugin,
      }) => (
        <AppConfigCard key={`${plugin.id}-${app.id}`} app={app} plugin={plugin}
          onEdit={() => onEditPlugin(plugin)} onDelete={() => onDeleteApp(plugin.id, app.id)}
          onRun={() => handleRun(plugin.id, getAppIdentifier(app, plugin.id))}
          isRunning={runningPlugins.has(plugin.id)}
          runStatus={runStatuses[plugin.id]} />
      ))}
    </>
  )
}

function EmptyState({ onCreateClick }: { readonly onCreateClick: () => void }) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="card text-center py-12">
      <Globe className="mx-auto h-12 w-12 text-gray-300 mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">{t('empty.title')}</h3>
      <p className="text-gray-500 mb-4">{t('empty.description')}</p>
      <button onClick={onCreateClick} className="btn btn-primary inline-flex items-center gap-2">
        <Plus size={16} /> {t('empty.createButton')}
      </button>
    </div>
  )
}

function useScraperMutations() {
  const queryClient = useQueryClient()

  const saveMutation = useMutation({
    mutationFn: (scraper: ScraperConfig) => scrapersApi.saveScraper(scraper),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scrapers'] }),
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => scrapersApi.deleteScraper(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scrapers'] }),
  })

  const runMutation = useMutation({ mutationFn: (id: string) => scrapersApi.runScraper(id) })

  return {
    saveMutation,
    deleteMutation,
    runMutation,
  }
}

function ScrapersContent({
  scrapers, isLoading, appConfigPlugins, onRefresh, onShowTemplates, onEdit, onDelete, onRun, onEditPlugin, onDeleteApp, onRunApp,
}: {
  readonly scrapers: ScraperConfig[]
  readonly isLoading: boolean
  readonly appConfigPlugins: PluginManifest[]
  readonly onRefresh: () => void
  readonly onShowTemplates: () => void
  readonly onEdit: (s: ScraperConfig) => void
  readonly onDelete: (id: string) => void
  readonly onRun: (id: string) => void
  readonly onEditPlugin: (p: PluginManifest) => void
  readonly onDeleteApp: (pluginId: string, appId: string) => void
  readonly onRunApp: (pluginId: string, appIdentifier: string) => void
}) {
  const { t } = useTranslation('scrapers')

  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-sm text-gray-500">{t('subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onRefresh} className="btn btn-secondary flex items-center justify-center gap-2 text-sm flex-1 sm:flex-none">
            <RefreshCw size={16} /> {t('refresh')}
          </button>
          <button onClick={onShowTemplates} className="btn btn-primary flex items-center justify-center gap-2 text-sm flex-1 sm:flex-none">
            <Plus size={16} /> {t('newSource')}
          </button>
        </div>
      </div>

      {isLoading ? <div className="flex items-center justify-center py-12"><Loader2 className="animate-spin h-8 w-8 text-blue-500" /></div> : null}
      {!isLoading && (
        <div className="grid gap-4">
          <AppConfigList plugins={appConfigPlugins} onEditPlugin={onEditPlugin} onDeleteApp={onDeleteApp} onRunApp={onRunApp} />
          {scrapers.map((scraper) => (
            <ScraperCard key={scraper.id} scraper={scraper} onEdit={() => onEdit(scraper)} onDelete={() => onDelete(scraper.id)} onRun={() => onRun(scraper.id)} />
          ))}
        </div>
      )}
      {!isLoading && scrapers.length === 0 && <EmptyState onCreateClick={onShowTemplates} />}
    </div>
  )
}

// eslint-disable-next-line complexity
export default function Scrapers() {
  const { t } = useTranslation('scrapers')
  const { config } = useConfigStore()
  const { setIsModalOpen } = useManualImportStore()
  const [editingScraper, setEditingScraper] = useState<ScraperConfig | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [deleteScraperId, setDeleteScraperId] = useState<string | null>(null)
  const [selectedTemplate, setSelectedTemplate] = useState<ScraperTemplate | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<PluginManifest | null>(null)
  const [showJsonUpload, setShowJsonUpload] = useState(false)
  const [deleteAppInfo, setDeleteAppInfo] = useState<{
    pluginId: string;
    appId: string
  } | null>(null)

  const appConfigPlugins = getAppConfigPlugins()

  const {
    data, isLoading, refetch,
  } = useQuery({
    queryKey: ['scrapers'],
    queryFn: scrapersApi.getScrapers,
    enabled: config.apiEndpoint.length > 0,
  })

  const {
    saveMutation,
    deleteMutation,
    runMutation,
  } = useScraperMutations()
  const scrapers = data?.scrapers ?? []

  const queryClient = useQueryClient()
  const deleteAppMutation = useMutation({
    mutationFn: ({
      pluginId, appId,
    }: {
      pluginId: string;
      appId: string
    }) => api.deleteAppConfig(pluginId, appId),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['app-configs', variables.pluginId] })
      void queryClient.invalidateQueries({ queryKey: ['all-app-configs'] })
      setDeleteAppInfo(null)
    },
  })

  const handleSelectTemplate = (template: ScraperTemplate) => {
    setSelectedTemplate(template)
    setShowTemplates(false)
    setIsCreating(true)
  }

  const handleSelectPlugin = (plugin: PluginManifest) => {
    setShowTemplates(false)
    setSelectedPlugin(plugin)
  }

  const handleSaveScraper = (scraper: ScraperConfig) => {
    saveMutation.mutate(scraper)
    setEditingScraper(null)
    setIsCreating(false)
    setSelectedTemplate(null)
  }

  const handleCloseEditor = () => {
    setEditingScraper(null)
    setIsCreating(false)
    setSelectedTemplate(null)
  }

  const handleConfirmDelete = () => {
    if (deleteScraperId != null && deleteScraperId !== '') {
      deleteMutation.mutate(deleteScraperId)
      setDeleteScraperId(null)
    }
  }

  if (config.apiEndpoint === '') {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-amber-500 mb-4" />
          <p className="text-gray-500 mb-4">{t('configureApiFirst')}</p>
          <a href="/settings" className="btn btn-primary">{t('goToSettings', { ns: 'common' })}</a>
        </div>
      </div>
    )
  }

  return (
    <>
      <ScrapersContent
        scrapers={scrapers}
        isLoading={isLoading}
        appConfigPlugins={appConfigPlugins}
        onRefresh={() => void refetch()}
        onShowTemplates={() => setShowTemplates(true)}
        onEdit={setEditingScraper}
        onDelete={setDeleteScraperId}
        onRun={(id) => runMutation.mutate(id)}
        onEditPlugin={(plugin) => setSelectedPlugin(plugin)}
        onDeleteApp={(pluginId, appId) => setDeleteAppInfo({
          pluginId,
          appId,
        })}
        onRunApp={(pluginId, appIdentifier) => void api.runSource(pluginId, appIdentifier)}
      />

      <ManualImportModal />
      <JsonUploadModal isOpen={showJsonUpload} onClose={() => setShowJsonUpload(false)} />

      {showTemplates ? <TemplateSelector onSelect={handleSelectTemplate} onSelectPlugin={handleSelectPlugin} onManualImport={() => {
        setShowTemplates(false); setIsModalOpen(true)
      }} onJsonUpload={() => {
        setShowTemplates(false); setShowJsonUpload(true)
      }} onClose={() => setShowTemplates(false)} /> : null}

      {selectedPlugin == null ? null : <PluginConfigModal
        plugin={selectedPlugin}
        onClose={() => setSelectedPlugin(null)}
      />}

      {(isCreating || editingScraper != null) ? <ScraperEditor scraper={editingScraper} template={selectedTemplate} onSave={handleSaveScraper} onClose={handleCloseEditor} /> : null}

      {deleteScraperId != null && deleteScraperId !== '' ? <ConfirmModal
        isOpen={deleteScraperId !== ''}
        title={t('deleteConfirmTitle')}
        message={t('deleteConfirmMessage')}
        confirmLabel={t('deleteConfirmLabel')}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteScraperId(null)}
      /> : null}

      {deleteAppInfo == null ? null : <ConfirmModal
        isOpen
        title="Delete App"
        message="Are you sure you want to remove this app configuration?"
        confirmLabel="Delete"
        onConfirm={() => {
          deleteAppMutation.mutate(deleteAppInfo)
        }}
        onCancel={() => setDeleteAppInfo(null)}
      />}
    </>
  )
}
