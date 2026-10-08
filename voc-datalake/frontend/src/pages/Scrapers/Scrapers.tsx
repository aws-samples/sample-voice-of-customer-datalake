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
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { scrapersApi } from '../../api/scrapersApi'
import ConfirmModal from '../../components/ConfirmModal/ConfirmModal'
import LoadFailed from '../../components/LoadFailed/LoadFailed'
import { failedReads, type FailedReads } from '../../utils/failedReads'
import { getPluginManifests, getSyntheticPlugins } from '../../plugins'
import { useIsAdmin } from '../../store/authStore'
import { useConfigStore } from '../../store/configStore'
import { useManualImportStore } from '../../store/manualImportStore'
import { serverReason } from '../../lib/errors'
import GeneratorConfigModal from './GeneratorConfigModal'
import JsonUploadModal from './JsonUploadModal'
import CsvUploadModal from './CsvUploadModal'
import AppConfigList from './AppConfigList'
import ManualImportModal from './ManualImportModal'
import PluginConfigModal from './PluginConfigModal'
import ScraperCard from './ScraperCard'
import ScraperEditor from './ScraperEditor'
import { supportsAppConfigs } from './scraper-helpers'
import SyntheticSourceCard from './SyntheticSourceCard'
import TemplateSelector from './TemplateSelector'
import type {
  ScraperConfig, ScraperTemplate,
} from '../../api/types'
import type { PluginManifest } from '../../plugins/types'
import { PageTitle } from '../../components/PageTitle/PageTitle'

function getAppConfigPlugins(): PluginManifest[] {
  return getPluginManifests().filter((p) => supportsAppConfigs(p.id))
}

/** What the editor shows for the save mutation's `error`: null while there is none. */
function saveErrorText(error: Error | null, fallback: string): string | null {
  if (error == null) return null
  return serverReason(error) ?? fallback
}

function EmptyState({ onCreateClick }: { readonly onCreateClick: () => void }) {
  const { t } = useTranslation('scrapers')
  return (
    <div className="card text-center py-12">
      <Globe size={20} className="mx-auto text-muted mb-3" aria-hidden="true" />
      <h2 className="text-sm font-semibold text-text-strong">{t('empty.title')}</h2>
      <p className="text-sm text-muted mt-1 mb-4">{t('empty.description')}</p>
      <button onClick={onCreateClick} className="btn btn-secondary">
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
  scrapers, isLoading, appConfigPlugins, syntheticPlugins, isAdmin, onRefresh, onShowTemplates, onEdit, onDelete, onRun, onEditPlugin, onDeleteApp, onRunApp, onGenerate, failure,
}: {
  readonly scrapers: ScraperConfig[]
  readonly isLoading: boolean
  readonly isAdmin: boolean
  readonly appConfigPlugins: PluginManifest[]
  readonly syntheticPlugins: PluginManifest[]
  readonly onRefresh: () => void
  readonly onShowTemplates: () => void
  readonly onEdit: (s: ScraperConfig) => void
  readonly onDelete: (id: string) => void
  readonly onRun: (id: string) => void
  readonly onEditPlugin: (p: PluginManifest) => void
  readonly onDeleteApp: (pluginId: string, appId: string) => void
  readonly onRunApp: (pluginId: string, appIdentifier: string) => Promise<unknown>
  readonly onGenerate: (p: PluginManifest) => void
  /** The scrapers read failed with nothing cached (not "no sources"). */
  readonly failure: FailedReads
}) {
  const { t } = useTranslation('scrapers')

  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <PageTitle title={t('title')} subtitle={t('subtitle')} />
        <div className="flex gap-2">
          <button onClick={onRefresh} className="btn btn-secondary justify-center flex-1 sm:flex-none">
            <RefreshCw size={16} /> {t('refresh')}
          </button>
          <button onClick={onShowTemplates} className="btn btn-primary justify-center flex-1 sm:flex-none">
            <Plus size={16} /> {t('newSource')}
          </button>
        </div>
      </div>

      {isLoading ? <div className="flex items-center justify-center py-12" role="status" aria-label={t('loading')}><Loader2 className="animate-spin text-accent" size={24} /></div> : null}
      {/* A failed read is not "no sources": say so and offer a retry instead of the create-first empty state. */}
      {!isLoading && failure.loadFailed ? <LoadFailed onRetry={failure.retry} retrying={failure.retrying} /> : null}
      {!isLoading && (
        <div className="grid grid-cols-1 gap-4">
          <AppConfigList plugins={appConfigPlugins} isAdmin={isAdmin} onEditPlugin={onEditPlugin} onDeleteApp={onDeleteApp} onRunApp={onRunApp} />
          {scrapers.map((scraper) => (
            <ScraperCard key={scraper.id} scraper={scraper} isAdmin={isAdmin} onEdit={() => onEdit(scraper)} onDelete={() => onDelete(scraper.id)} onRun={() => onRun(scraper.id)} />
          ))}
          {syntheticPlugins.length > 0 ? (
            <section aria-labelledby="synthetic-sources-heading" className="pt-2">
              <h2 id="synthetic-sources-heading" className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted mb-2">{t('syntheticCard.sectionTitle')}</h2>
              <div className="grid grid-cols-1 gap-4">
                {syntheticPlugins.map((plugin) => (
                  <SyntheticSourceCard key={plugin.id} plugin={plugin} onGenerate={() => onGenerate(plugin)} />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
      {!isLoading && !failure.loadFailed && scrapers.length === 0 && syntheticPlugins.length === 0 && <EmptyState onCreateClick={onShowTemplates} />}
    </div>
  )
}

export default function Scrapers() {
  const { t } = useTranslation('scrapers')
  const { config } = useConfigStore()
  const isAdmin = useIsAdmin()
  const { setIsModalOpen } = useManualImportStore()
  const [editingScraper, setEditingScraper] = useState<ScraperConfig | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [deleteScraperId, setDeleteScraperId] = useState<string | null>(null)
  const [selectedTemplate, setSelectedTemplate] = useState<ScraperTemplate | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<PluginManifest | null>(null)
  const [selectedGenerator, setSelectedGenerator] = useState<PluginManifest | null>(null)
  const [showJsonUpload, setShowJsonUpload] = useState(false)
  const [showCsvUpload, setShowCsvUpload] = useState(false)
  const [deleteAppInfo, setDeleteAppInfo] = useState<{
    pluginId: string;
    appId: string
  } | null>(null)

  const appConfigPlugins = getAppConfigPlugins()
  const syntheticPlugins = getSyntheticPlugins()

  const scrapersQuery = useQuery({
    queryKey: ['scrapers'],
    queryFn: scrapersApi.getScrapers,
    enabled: config.apiEndpoint.length > 0,
  })
  const { data, isLoading, refetch } = scrapersQuery

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

  const handleCloseEditor = () => {
    saveMutation.reset()
    setEditingScraper(null)
    setIsCreating(false)
    setSelectedTemplate(null)
  }

  // The editor closes only once the save succeeded: a rejected save (e.g. a 400
  // from the save limits) keeps the draft open and shows why. Returns the
  // promise so the unsaved-changes guard's Save can wait for it.
  const handleSaveScraper = async (scraper: ScraperConfig) => {
    await saveMutation.mutateAsync(scraper)
    handleCloseEditor()
  }
  const saveError = saveErrorText(saveMutation.error, t('editor.saveFailed'))

  const handleConfirmDelete = () => {
    if (deleteScraperId != null && deleteScraperId !== '') {
      deleteMutation.mutate(deleteScraperId)
      setDeleteScraperId(null)
    }
  }

  if (config.apiEndpoint === '') {
    return (
      <div className="card max-w-md mx-auto text-center py-12">
        <AlertCircle size={20} className="mx-auto text-warn mb-3" aria-hidden="true" />
        <p className="text-sm text-muted mb-4">{t('configureApiFirst')}</p>
        <a href="/admin" className="btn btn-primary">{t('goToSettings', { ns: 'common' })}</a>
      </div>
    )
  }

  return (
    <>
      <ScrapersContent
        scrapers={scrapers}
        isLoading={isLoading}
        appConfigPlugins={appConfigPlugins}
        syntheticPlugins={syntheticPlugins}
        isAdmin={isAdmin}
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
        onRunApp={(pluginId, appIdentifier) => api.runSource(pluginId, appIdentifier)}
        onGenerate={(plugin) => setSelectedGenerator(plugin)}
        failure={failedReads([scrapersQuery])}
      />

      <ManualImportModal />
      <JsonUploadModal isOpen={showJsonUpload} onClose={() => setShowJsonUpload(false)} />
      <CsvUploadModal isOpen={showCsvUpload} onClose={() => setShowCsvUpload(false)} />

      {showTemplates ? <TemplateSelector onSelect={handleSelectTemplate} onSelectPlugin={handleSelectPlugin} onSelectGenerator={(plugin) => {
        setShowTemplates(false); setSelectedGenerator(plugin)
      }} onManualImport={() => {
        setShowTemplates(false); setIsModalOpen(true)
      }} onJsonUpload={() => {
        setShowTemplates(false); setShowJsonUpload(true)
      }} onCsvUpload={() => {
        setShowTemplates(false); setShowCsvUpload(true)
      }} onClose={() => setShowTemplates(false)} /> : null}

      {selectedPlugin == null ? null : <PluginConfigModal
        plugin={selectedPlugin}
        isAdmin={isAdmin}
        onClose={() => setSelectedPlugin(null)}
      />}

      {selectedGenerator == null ? null : <GeneratorConfigModal
        plugin={selectedGenerator}
        isAdmin={isAdmin}
        onClose={() => {
          setSelectedGenerator(null)
          // Refresh synthetic cards so a just-finished run shows immediately.
          void queryClient.invalidateQueries({ queryKey: ['source-run-status'] })
        }}
      />}

      {(isCreating || editingScraper != null) ? <ScraperEditor scraper={editingScraper} template={selectedTemplate} isAdmin={isAdmin} onSave={handleSaveScraper} onClose={handleCloseEditor} saveError={saveError} isSaving={saveMutation.isPending} /> : null}

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
        title={t('appCard.deleteConfirmTitle')}
        message={t('appCard.deleteConfirmMessage')}
        confirmLabel={t('deleteConfirmLabel')}
        onConfirm={() => {
          deleteAppMutation.mutate(deleteAppInfo)
        }}
        onCancel={() => setDeleteAppInfo(null)}
      />}
    </>
  )
}
