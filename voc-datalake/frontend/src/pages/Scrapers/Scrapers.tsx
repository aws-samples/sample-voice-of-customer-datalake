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
import { scrapersApi } from '../../api/scrapersApi'
import ConfirmModal from '../../components/ConfirmModal'
import { useConfigStore } from '../../store/configStore'
import { useManualImportStore } from '../../store/manualImportStore'
import JsonUploadModal from './JsonUploadModal'
import ManualImportModal from './ManualImportModal'
import PluginConfigModal from './PluginConfigModal'
import ScraperCard from './ScraperCard'
import ScraperEditor from './ScraperEditor'
import TemplateSelector from './TemplateSelector'
import type {
  ScraperConfig, ScraperTemplate,
} from '../../api/types'
import type { PluginManifest } from '../../plugins/types'

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

function ScraperList({
  scrapers, onEdit, onDelete, onRun,
}: {
  readonly scrapers: ScraperConfig[]
  readonly onEdit: (s: ScraperConfig) => void
  readonly onDelete: (id: string) => void
  readonly onRun: (id: string) => void
}) {
  return (
    <div className="grid gap-4">
      {scrapers.map((scraper) => (
        <ScraperCard
          key={scraper.id}
          scraper={scraper}
          onEdit={() => onEdit(scraper)}
          onDelete={() => onDelete(scraper.id)}
          onRun={() => onRun(scraper.id)}
        />
      ))}
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
  scrapers, isLoading, onRefresh, onShowTemplates, onEdit, onDelete, onRun,
}: {
  readonly scrapers: ScraperConfig[]
  readonly isLoading: boolean
  readonly onRefresh: () => void
  readonly onShowTemplates: () => void
  readonly onEdit: (s: ScraperConfig) => void
  readonly onDelete: (id: string) => void
  readonly onRun: (id: string) => void
}) {
  const { t } = useTranslation('scrapers')

  function renderContent() {
    if (isLoading) {
      return <div className="flex items-center justify-center py-12"><Loader2 className="animate-spin h-8 w-8 text-blue-500" /></div>
    }
    if (scrapers.length === 0) {
      return <EmptyState onCreateClick={onShowTemplates} />
    }
    return <ScraperList scrapers={scrapers} onEdit={onEdit} onDelete={onDelete} onRun={onRun} />
  }

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

      {renderContent()}
    </div>
  )
}

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
        onRefresh={() => void refetch()}
        onShowTemplates={() => setShowTemplates(true)}
        onEdit={setEditingScraper}
        onDelete={setDeleteScraperId}
        onRun={(id) => runMutation.mutate(id)}
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
    </>
  )
}
