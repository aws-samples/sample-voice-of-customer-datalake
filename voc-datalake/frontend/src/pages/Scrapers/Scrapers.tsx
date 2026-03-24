/**
 * @fileoverview Web scraper configuration page.
 * @module pages/Scrapers
 */

import { useState, useEffect, type ReactElement } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Play, Settings, Globe, AlertCircle, CheckCircle, Loader2, XCircle, RefreshCw } from 'lucide-react'
import { api } from '../../api/client'
import type { ScraperConfig, ScraperTemplate } from '../../api/client'
import { useConfigStore } from '../../store/configStore'
import { useManualImportStore } from '../../store/manualImportStore'
import clsx from 'clsx'
import ConfirmModal from '../../components/ConfirmModal'
import ScraperEditor from './ScraperEditor'
import TemplateSelector from './TemplateSelector'
import PluginConfigModal from './PluginConfigModal'
import ManualImportModal from './ManualImportModal'
import JsonUploadModal from './JsonUploadModal'
import { FREQUENCY_OPTIONS } from './constants'
import type { PluginManifest } from '../../plugins/types'

interface RunStatus {
  status: string
  pages_scraped: number
  items_found: number
  errors: string[]
  started_at?: string
}

function getStatusStyle(status: RunStatus): string {
  if (status.status === 'running') return 'bg-blue-50 border-blue-200'
  if (status.status === 'error') return 'bg-red-50 border-red-200'
  if (status.errors?.length > 0) return 'bg-amber-50 border-amber-200'
  return 'bg-green-50 border-green-200'
}

function StatusIndicator({ status }: { readonly status: RunStatus }): ReactElement | null {
  if (status.status === 'running') {
    return <><Loader2 size={16} className="animate-spin text-blue-600" /><span className="font-medium text-blue-700">Running...</span></>
  }
  if (status.status === 'error') {
    return <><XCircle size={16} className="text-red-600" /><span className="font-medium text-red-700">Failed</span></>
  }
  if (status.errors?.length > 0) {
    return <><AlertCircle size={16} className="text-amber-600" /><span className="font-medium text-amber-700">Completed with errors</span></>
  }
  return <><CheckCircle size={16} className="text-green-600" /><span className="font-medium text-green-700">Completed</span></>
}

function ScraperRunStatus({ scraperId, onComplete }: { readonly scraperId: string; readonly onComplete?: () => void }) {
  const [status, setStatus] = useState<RunStatus | null>(null)
  const [polling, setPolling] = useState(true)

  useEffect(() => {
    if (!polling) return

    const poll = async () => {
      try {
        const result = await api.getScraperStatus(scraperId)
        setStatus(result)
        if (['completed', 'completed_with_errors', 'error'].includes(result.status)) {
          setPolling(false)
          onComplete?.()
        }
      } catch {
        // Ignore polling errors
      }
    }

    poll()
    const interval = setInterval(poll, 2000)
    return () => clearInterval(interval)
  }, [scraperId, polling, onComplete])

  if (!status || status.status === 'never_run') return null

  const hasErrors = status.errors?.length > 0

  return (
    <div className={clsx('mt-3 p-3 rounded-lg text-sm border', getStatusStyle(status))}>
      <div className="flex items-center gap-2 mb-2">
        <StatusIndicator status={status} />
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <div>Pages scraped: <span className="font-semibold">{status.pages_scraped}</span></div>
        <div>Reviews found: <span className="font-semibold">{status.items_found}</span></div>
      </div>
      {hasErrors && (
        <div className="mt-2 text-xs text-red-600">
          {status.errors.slice(0, 2).map((err, i) => <div key={i} className="truncate">{err}</div>)}
          {status.errors.length > 2 && <div>...and {status.errors.length - 2} more errors</div>}
        </div>
      )}
    </div>
  )
}

function getLastRunBadge(status: string): { className: string; icon: string } {
  if (status === 'completed') return { className: 'bg-green-100 text-green-700', icon: '✓' }
  if (status === 'error') return { className: 'bg-red-100 text-red-700', icon: '✗' }
  return { className: 'bg-amber-100 text-amber-700', icon: '⚠' }
}

function LastRunSummary({ lastRunInfo }: { readonly lastRunInfo: RunStatus }) {
  const badge = getLastRunBadge(lastRunInfo.status)
  return (
    <div className="mt-3 pt-3 border-t border-gray-100 text-xs text-gray-500">
      <div className="flex items-center justify-between">
        <span>Last: {lastRunInfo.pages_scraped} pages, {lastRunInfo.items_found} reviews</span>
        <span className={clsx('px-2 py-0.5 rounded', badge.className)}>{badge.icon}</span>
      </div>
      {lastRunInfo.errors?.length > 0 && <p className="text-red-500 truncate mt-1">{lastRunInfo.errors[0]}</p>}
    </div>
  )
}

function ScraperCardHeader({ scraper, isRunning, onRun, onEdit, onDelete }: {
  readonly scraper: ScraperConfig
  readonly isRunning: boolean
  readonly onRun: () => void
  readonly onEdit: () => void
  readonly onDelete: () => void
}) {
  const domain = scraper.base_url ? new URL(scraper.base_url).hostname : 'Not configured'
  return (
    <div className="flex items-start justify-between mb-3">
      <div className="flex items-center gap-3">
        <div className={clsx('w-10 h-10 rounded-lg flex items-center justify-center', scraper.enabled ? 'bg-green-100 text-green-600' : 'bg-gray-100 text-gray-400')}>
          <Globe size={20} />
        </div>
        <div>
          <h3 className="font-semibold">{scraper.name}</h3>
          <p className="text-sm text-gray-500">{domain}</p>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button onClick={onRun} disabled={isRunning || !scraper.base_url} className={clsx("p-2 rounded transition-colors", isRunning ? "bg-blue-100 text-blue-600" : "hover:bg-green-100 text-green-600")} title="Run now">
          {isRunning ? <Loader2 size={16} className="animate-spin" /> : <Play size={16} />}
        </button>
        <button onClick={onEdit} className="p-2 hover:bg-gray-100 rounded" title="Edit"><Settings size={16} /></button>
        <button onClick={onDelete} className="p-2 hover:bg-gray-100 rounded text-red-500" title="Delete"><Trash2 size={16} /></button>
      </div>
    </div>
  )
}

function calculateTotalUrls(scraper: ScraperConfig): number {
  const additionalUrls = scraper.urls?.length ?? 0
  const baseUrlCount = scraper.base_url ? 1 : 0
  const paginationCount = scraper.base_url && scraper.pagination?.enabled ? scraper.pagination.max_pages - 1 : 0
  return additionalUrls + baseUrlCount + paginationCount
}

function getFrequencyLabel(minutes: number): string {
  return FREQUENCY_OPTIONS.find(f => f.value === minutes)?.label ?? `${minutes}m`
}

function ScraperCardStats({ scraper, lastRunInfo }: { readonly scraper: ScraperConfig; readonly lastRunInfo: RunStatus | null }) {
  const totalUrls = calculateTotalUrls(scraper)
  const frequencyLabel = getFrequencyLabel(scraper.frequency_minutes)
  const lastRunDate = lastRunInfo?.started_at ? new Date(lastRunInfo.started_at).toLocaleDateString() : 'Never'

  return (
    <div className="grid grid-cols-3 gap-4 text-sm">
      <div><span className="text-gray-500">Frequency</span><p className="font-medium">{frequencyLabel}</p></div>
      <div><span className="text-gray-500">URLs</span><p className="font-medium">{totalUrls}</p></div>
      <div><span className="text-gray-500">Last Run</span><p className="font-medium">{lastRunDate}</p></div>
    </div>
  )
}

function useScraperStatus(scraperId: string) {
  const [showStatus, setShowStatus] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [lastRunInfo, setLastRunInfo] = useState<RunStatus | null>(null)

  useEffect(() => {
    api.getScraperStatus(scraperId).then(result => {
      if (result.status !== 'never_run') setLastRunInfo(result)
    }).catch(() => {})
  }, [scraperId])

  const handleRun = (onRun: () => void) => {
    setIsRunning(true)
    setShowStatus(true)
    onRun()
  }

  const handleComplete = () => {
    setIsRunning(false)
    api.getScraperStatus(scraperId).then(result => {
      if (result.status !== 'never_run') setLastRunInfo(result)
    })
  }

  return { showStatus, isRunning, lastRunInfo, handleRun, handleComplete }
}

function ScraperCard({ scraper, onEdit, onDelete, onRun }: {
  readonly scraper: ScraperConfig
  readonly onEdit: () => void
  readonly onDelete: () => void
  readonly onRun: () => void
}) {
  const { showStatus, isRunning, lastRunInfo, handleRun, handleComplete } = useScraperStatus(scraper.id)
  const showLastRunSummary = lastRunInfo && lastRunInfo.status !== 'never_run' && !showStatus

  return (
    <div className={clsx('card border-2 transition-all', scraper.enabled ? 'border-green-200 bg-green-50/30' : 'border-gray-200 opacity-60')}>
      <ScraperCardHeader scraper={scraper} isRunning={isRunning} onRun={() => handleRun(onRun)} onEdit={onEdit} onDelete={onDelete} />
      <ScraperCardStats scraper={scraper} lastRunInfo={lastRunInfo} />
      {showLastRunSummary && <LastRunSummary lastRunInfo={lastRunInfo} />}
      {showStatus && <ScraperRunStatus scraperId={scraper.id} onComplete={handleComplete} />}
    </div>
  )
}

function EmptyState({ onCreateClick }: { readonly onCreateClick: () => void }) {
  return (
    <div className="card text-center py-12">
      <Globe className="mx-auto h-12 w-12 text-gray-300 mb-4" />
      <h3 className="text-lg font-medium text-gray-900 mb-2">No scrapers configured</h3>
      <p className="text-gray-500 mb-4">Create a scraper to start collecting feedback from websites</p>
      <button onClick={onCreateClick} className="btn btn-primary inline-flex items-center gap-2">
        <Plus size={16} /> Create Scraper
      </button>
    </div>
  )
}

function ScraperList({ scrapers, onEdit, onDelete, onRun }: {
  readonly scrapers: ScraperConfig[]
  readonly onEdit: (s: ScraperConfig) => void
  readonly onDelete: (id: string) => void
  readonly onRun: (id: string) => void
}) {
  return (
    <div className="grid gap-4">
      {scrapers.map(scraper => (
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
    mutationFn: (scraper: ScraperConfig) => api.saveScraper(scraper),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scrapers'] })
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteScraper(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['scrapers'] })
  })

  const runMutation = useMutation({
    mutationFn: (id: string) => api.runScraper(id),
  })

  return { saveMutation, deleteMutation, runMutation }
}

function ScrapersContent({ scrapers, isLoading, onRefresh, onShowTemplates, onEdit, onDelete, onRun }: {
  readonly scrapers: ScraperConfig[]
  readonly isLoading: boolean
  readonly onRefresh: () => void
  readonly onShowTemplates: () => void
  readonly onEdit: (s: ScraperConfig) => void
  readonly onDelete: (id: string) => void
  readonly onRun: (id: string) => void
}) {
  return (
    <div className="max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900">Data Sources</h1>
          <p className="text-sm text-gray-500">Configure web scrapers and app review sources to collect feedback</p>
        </div>
        <div className="flex gap-2">
          <button onClick={onRefresh} className="btn btn-secondary flex items-center justify-center gap-2 text-sm flex-1 sm:flex-none">
            <RefreshCw size={16} /> Refresh
          </button>
          <button onClick={onShowTemplates} className="btn btn-primary flex items-center justify-center gap-2 text-sm flex-1 sm:flex-none">
            <Plus size={16} /> New Source
          </button>
        </div>
      </div>

      {isLoading && <div className="flex items-center justify-center py-12"><Loader2 className="animate-spin h-8 w-8 text-blue-500" /></div>}
      {!isLoading && scrapers.length === 0 && <EmptyState onCreateClick={onShowTemplates} />}
      {!isLoading && scrapers.length > 0 && <ScraperList scrapers={scrapers} onEdit={onEdit} onDelete={onDelete} onRun={onRun} />}
    </div>
  )
}

export default function Scrapers() {
  const { config } = useConfigStore()
  const { setIsModalOpen } = useManualImportStore()
  const [editingScraper, setEditingScraper] = useState<ScraperConfig | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [deleteScraperId, setDeleteScraperId] = useState<string | null>(null)
  const [selectedTemplate, setSelectedTemplate] = useState<ScraperTemplate | null>(null)
  const [selectedPlugin, setSelectedPlugin] = useState<PluginManifest | null>(null)
  const [showJsonUpload, setShowJsonUpload] = useState(false)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['scrapers'],
    queryFn: api.getScrapers,
    enabled: !!config.apiEndpoint,
  })

  const { saveMutation, deleteMutation, runMutation } = useScraperMutations()
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
    if (deleteScraperId) {
      deleteMutation.mutate(deleteScraperId)
      setDeleteScraperId(null)
    }
  }

  if (!config.apiEndpoint) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-center">
          <AlertCircle className="mx-auto h-12 w-12 text-amber-500 mb-4" />
          <p className="text-gray-500 mb-4">Configure API endpoint first</p>
          <a href="/settings" className="btn btn-primary">Go to Settings</a>
        </div>
      </div>
    )
  }

  return (
    <>
      <ScrapersContent
        scrapers={scrapers}
        isLoading={isLoading}
        onRefresh={() => refetch()}
        onShowTemplates={() => setShowTemplates(true)}
        onEdit={setEditingScraper}
        onDelete={setDeleteScraperId}
        onRun={id => runMutation.mutate(id)}
      />

      <ManualImportModal />
      <JsonUploadModal isOpen={showJsonUpload} onClose={() => setShowJsonUpload(false)} />

      {showTemplates && <TemplateSelector onSelect={handleSelectTemplate} onSelectPlugin={handleSelectPlugin} onManualImport={() => { setShowTemplates(false); setIsModalOpen(true) }} onJsonUpload={() => { setShowTemplates(false); setShowJsonUpload(true) }} onClose={() => setShowTemplates(false)} />}

      {selectedPlugin && (
        <PluginConfigModal
          plugin={selectedPlugin}
          onClose={() => setSelectedPlugin(null)}
        />
      )}

      {(isCreating || editingScraper) && (
        <ScraperEditor scraper={editingScraper} template={selectedTemplate} onSave={handleSaveScraper} onClose={handleCloseEditor} />
      )}

      {deleteScraperId && (
        <ConfirmModal
          isOpen={!!deleteScraperId}
          title="Delete Scraper"
          message="Are you sure you want to delete this scraper? This action cannot be undone."
          confirmLabel="Delete"
          onConfirm={handleConfirmDelete}
          onCancel={() => setDeleteScraperId(null)}
        />
      )}
    </>
  )
}
