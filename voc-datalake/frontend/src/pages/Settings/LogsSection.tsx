/**
 * @fileoverview Logs section for Settings page.
 * @module pages/Settings/LogsSection
 * 
 * Displays validation failures, processing errors, and scraper logs.
 */

import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { 
  AlertTriangle, XCircle, RefreshCw, Trash2, ChevronDown, 
  Clock, FileWarning, Loader2, CheckCircle, AlertCircle 
} from 'lucide-react'
import { api } from '../../api/client'
import type { ValidationLogEntry, ProcessingLogEntry } from '../../api/types'
import clsx from 'clsx'

type LogTab = 'validation' | 'processing' | 'scrapers'

interface LogsSectionProps {
  readonly apiEndpoint: string
}

export default function LogsSection({ apiEndpoint }: LogsSectionProps) {
  const [activeTab, setActiveTab] = useState<LogTab>('validation')
  const [days, setDays] = useState(7)

  if (!apiEndpoint) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <FileWarning className="text-amber-600" size={20} />
          <h2 className="text-lg font-semibold">System Logs</h2>
        </div>
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>Configure the API endpoint in the Brand tab to view logs.</span>
        </div>
      </div>
    )
  }

  const tabs = [
    { id: 'validation' as const, label: 'Validation Failures', icon: AlertTriangle },
    { id: 'processing' as const, label: 'Processing Errors', icon: XCircle },
    { id: 'scrapers' as const, label: 'Scraper Runs', icon: RefreshCw },
  ]

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileWarning className="text-amber-600" size={20} />
            <h2 className="text-lg font-semibold">System Logs</h2>
          </div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="input w-auto text-sm"
          >
            <option value={1}>Last 24 hours</option>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
          </select>
        </div>

        <LogsSummaryCard days={days} />

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-200 mt-4">
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700'
              )}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      {activeTab === 'validation' && <ValidationLogsPanel days={days} />}
      {activeTab === 'processing' && <ProcessingLogsPanel days={days} />}
      {activeTab === 'scrapers' && <ScraperLogsPanel days={days} />}
    </div>
  )
}

// ============================================
// Summary Card
// ============================================

interface SummaryCardItemProps {
  readonly count: number
  readonly label: string
  readonly icon: typeof AlertTriangle
  readonly colorScheme: 'amber' | 'red'
}

function SummaryCardItem({ count, label, icon: Icon, colorScheme }: SummaryCardItemProps) {
  const hasIssues = count > 0

  // Determine classes based on state
  const getContainerClass = () => {
    if (!hasIssues) return 'bg-green-50 border border-green-200'
    if (colorScheme === 'amber') return 'bg-amber-50 border border-amber-200'
    return 'bg-red-50 border border-red-200'
  }

  const getIconColorClass = () => {
    if (!hasIssues) return 'text-green-600'
    if (colorScheme === 'amber') return 'text-amber-600'
    return 'text-red-600'
  }

  const getCountColorClass = () => {
    if (!hasIssues) return 'text-green-700'
    if (colorScheme === 'amber') return 'text-amber-700'
    return 'text-red-700'
  }

  return (
    <div className={clsx('p-3 rounded-lg', getContainerClass())}>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={16} className={getIconColorClass()} />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className={clsx('text-2xl font-bold', getCountColorClass())}>
        {count}
      </p>
    </div>
  )
}

function LogsSummaryCard({ days }: { readonly days: number }) {
  const { data, isLoading } = useQuery({
    queryKey: ['logs-summary', days],
    queryFn: () => api.getLogsSummary(days),
    refetchInterval: 30000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" />
        Loading summary...
      </div>
    )
  }

  const summary = data?.summary
  const totalValidation = summary?.total_validation_failures ?? 0
  const totalProcessing = summary?.total_processing_errors ?? 0

  return (
    <div className="grid grid-cols-2 gap-4">
      <SummaryCardItem 
        count={totalValidation} 
        label="Validation Failures" 
        icon={AlertTriangle} 
        colorScheme="amber" 
      />
      <SummaryCardItem 
        count={totalProcessing} 
        label="Processing Errors" 
        icon={XCircle} 
        colorScheme="red" 
      />
    </div>
  )
}

// ============================================
// Validation Logs Panel
// ============================================

function ValidationLogsPanel({ days }: { readonly days: number }) {
  const queryClient = useQueryClient()
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['validation-logs', days],
    queryFn: () => api.getValidationLogs({ days, limit: 100 }),
  })

  const clearMutation = useMutation({
    mutationFn: (source: string) => api.clearValidationLogs(source),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['validation-logs'] })
      queryClient.invalidateQueries({ queryKey: ['logs-summary'] })
    },
  })

  if (isLoading) {
    return <LogsLoadingState />
  }

  const logs = data?.logs ?? []

  if (logs.length === 0) {
    return <LogsEmptyState message="No validation failures in this period" icon={CheckCircle} />
  }

  // Group by source
  const groupedLogs = logs.reduce<Record<string, ValidationLogEntry[]>>((acc, log) => {
    const source = log.source_platform
    if (!acc[source]) acc[source] = []
    acc[source].push(log)
    return acc
  }, {})

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => refetch()} className="btn btn-secondary text-sm flex items-center gap-1">
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {Object.entries(groupedLogs).map(([source, sourceLogs]) => (
        <div key={source} className="card">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="font-medium">{source}</span>
              <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
                {sourceLogs.length} failures
              </span>
            </div>
            <button
              onClick={() => clearMutation.mutate(source)}
              disabled={clearMutation.isPending}
              className="btn btn-secondary text-xs flex items-center gap-1"
            >
              {clearMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
              Clear
            </button>
          </div>

          <div className="space-y-2">
            {sourceLogs.slice(0, 5).map((log, idx) => {
              const logKey = `${log.source_platform}-${log.message_id}-${idx}`
              const isExpanded = expandedLog === logKey

              return (
                <div key={logKey} className="border border-gray-200 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedLog(isExpanded ? null : logKey)}
                    className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                      <span className="text-sm truncate">{log.message_id}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">{formatTimestamp(log.timestamp)}</span>
                      <ChevronDown size={14} className={clsx('text-gray-400 transition-transform', isExpanded && 'rotate-180')} />
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="p-3 bg-gray-50 border-t border-gray-200 text-sm">
                      <div className="mb-2">
                        <span className="font-medium text-gray-700">Errors:</span>
                        <ul className="mt-1 list-disc list-inside text-red-600">
                          {log.errors.map((err, i) => <li key={i}>{err}</li>)}
                        </ul>
                      </div>
                      {log.raw_preview && (
                        <div>
                          <span className="font-medium text-gray-700">Raw Preview:</span>
                          <pre className="mt-1 p-2 bg-gray-100 rounded text-xs overflow-x-auto">
                            {log.raw_preview}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
            {sourceLogs.length > 5 && (
              <p className="text-xs text-gray-500 text-center py-2">
                +{sourceLogs.length - 5} more entries
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ============================================
// Processing Logs Panel
// ============================================

function ProcessingLogsPanel({ days }: { readonly days: number }) {
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['processing-logs', days],
    queryFn: () => api.getProcessingLogs({ days, limit: 100 }),
  })

  if (isLoading) {
    return <LogsLoadingState />
  }

  const logs = data?.logs ?? []

  if (logs.length === 0) {
    return <LogsEmptyState message="No processing errors in this period" icon={CheckCircle} />
  }

  // Group by source
  const groupedLogs = logs.reduce<Record<string, ProcessingLogEntry[]>>((acc, log) => {
    const source = log.source_platform
    if (!acc[source]) acc[source] = []
    acc[source].push(log)
    return acc
  }, {})

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => refetch()} className="btn btn-secondary text-sm flex items-center gap-1">
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>

      {Object.entries(groupedLogs).map(([source, sourceLogs]) => (
        <div key={source} className="card">
          <div className="flex items-center gap-2 mb-3">
            <span className="font-medium">{source}</span>
            <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
              {sourceLogs.length} errors
            </span>
          </div>

          <div className="space-y-2">
            {sourceLogs.slice(0, 5).map((log, idx) => {
              const logKey = `${log.source_platform}-${log.message_id}-${idx}`
              const isExpanded = expandedLog === logKey

              return (
                <div key={logKey} className="border border-gray-200 rounded-lg overflow-hidden">
                  <button
                    onClick={() => setExpandedLog(isExpanded ? null : logKey)}
                    className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <XCircle size={14} className="text-red-500 flex-shrink-0" />
                      <span className="text-sm font-medium text-red-700">{log.error_type}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">{formatTimestamp(log.timestamp)}</span>
                      <ChevronDown size={14} className={clsx('text-gray-400 transition-transform', isExpanded && 'rotate-180')} />
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="p-3 bg-gray-50 border-t border-gray-200 text-sm">
                      <div className="mb-2">
                        <span className="font-medium text-gray-700">Message ID:</span>
                        <span className="ml-2 text-gray-600">{log.message_id}</span>
                      </div>
                      <div>
                        <span className="font-medium text-gray-700">Error:</span>
                        <p className="mt-1 text-red-600">{log.error_message}</p>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}
            {sourceLogs.length > 5 && (
              <p className="text-xs text-gray-500 text-center py-2">
                +{sourceLogs.length - 5} more entries
              </p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ============================================
// Scraper Logs Panel
// ============================================

function ScraperLogsPanel({ days }: { readonly days: number }) {
  const { data: scrapersData, isLoading: loadingScrapers } = useQuery({
    queryKey: ['scrapers'],
    queryFn: () => api.getScrapers(),
  })

  if (loadingScrapers) {
    return <LogsLoadingState />
  }

  const scrapers = scrapersData?.scrapers ?? []

  if (scrapers.length === 0) {
    return <LogsEmptyState message="No scrapers configured" icon={RefreshCw} />
  }

  return (
    <div className="space-y-3">
      {scrapers.map(scraper => (
        <ScraperLogCard key={scraper.id} scraperId={scraper.id} scraperName={scraper.name} days={days} />
      ))}
    </div>
  )
}

function ScraperLogCard({ scraperId, scraperName, days }: { readonly scraperId: string; readonly scraperName: string; readonly days: number }) {
  const [isExpanded, setIsExpanded] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['scraper-logs', scraperId, days],
    queryFn: () => api.getScraperLogs(scraperId, { days, limit: 10 }),
    enabled: isExpanded,
  })

  const logs = data?.logs ?? []
  const latestRun = logs[0]

  return (
    <div className="card">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between text-left"
      >
        <div className="flex items-center gap-2">
          <RefreshCw size={16} className="text-gray-500" />
          <span className="font-medium">{scraperName}</span>
          {latestRun && (
            <ScraperStatusBadge status={latestRun.status} />
          )}
        </div>
        <ChevronDown size={16} className={clsx('text-gray-400 transition-transform', isExpanded && 'rotate-180')} />
      </button>

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-gray-100">
          <ScraperLogContent isLoading={isLoading} logs={logs} />
        </div>
      )}
    </div>
  )
}

interface ScraperLogContentProps {
  readonly isLoading: boolean
  readonly logs: Array<{ run_id: string; status: string; started_at: string; pages_scraped: number; items_found: number; errors: string[] }>
}

function ScraperLogContent({ isLoading, logs }: ScraperLogContentProps) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={14} className="animate-spin" />
        Loading runs...
      </div>
    )
  }

  if (logs.length === 0) {
    return <p className="text-sm text-gray-500">No runs in this period</p>
  }

  return (
    <div className="space-y-2">
      {logs.map(log => (
        <div key={log.run_id} className="flex items-center justify-between p-2 bg-gray-50 rounded-lg text-sm">
          <div className="flex items-center gap-3">
            <ScraperStatusBadge status={log.status} />
            <span className="text-gray-600">{formatTimestamp(log.started_at)}</span>
          </div>
          <div className="flex items-center gap-4 text-gray-500">
            <span>{log.pages_scraped} pages</span>
            <span>{log.items_found} items</span>
            {log.errors.length > 0 && (
              <span className="text-red-600">{log.errors.length} errors</span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

function ScraperStatusBadge({ status }: { readonly status: string }) {
  const statusConfig: Record<string, { bg: string; text: string; icon: typeof CheckCircle }> = {
    completed: { bg: 'bg-green-100', text: 'text-green-700', icon: CheckCircle },
    running: { bg: 'bg-blue-100', text: 'text-blue-700', icon: Loader2 },
    error: { bg: 'bg-red-100', text: 'text-red-700', icon: XCircle },
    completed_with_errors: { bg: 'bg-amber-100', text: 'text-amber-700', icon: AlertTriangle },
  }

  const config = statusConfig[status] ?? { bg: 'bg-gray-100', text: 'text-gray-700', icon: Clock }
  const Icon = config.icon

  return (
    <span className={clsx('text-xs px-2 py-0.5 rounded-full flex items-center gap-1', config.bg, config.text)}>
      <Icon size={12} className={status === 'running' ? 'animate-spin' : ''} />
      {status.replace(/_/g, ' ')}
    </span>
  )
}

// ============================================
// Shared Components
// ============================================

function LogsLoadingState() {
  return (
    <div className="card flex items-center justify-center py-8">
      <Loader2 size={24} className="animate-spin text-gray-400" />
    </div>
  )
}

function LogsEmptyState({ message, icon: Icon }: { readonly message: string; readonly icon: typeof CheckCircle }) {
  return (
    <div className="card flex flex-col items-center justify-center py-8 text-gray-500">
      <Icon size={32} className="mb-2 text-green-500" />
      <p>{message}</p>
    </div>
  )
}

function formatTimestamp(timestamp: string): string {
  try {
    const date = new Date(timestamp)
    const now = new Date()
    const diffMs = now.getTime() - date.getTime()
    const diffMins = Math.floor(diffMs / 60000)
    const diffHours = Math.floor(diffMs / 3600000)
    const diffDays = Math.floor(diffMs / 86400000)

    if (diffMins < 1) return 'just now'
    if (diffMins < 60) return `${diffMins}m ago`
    if (diffHours < 24) return `${diffHours}h ago`
    if (diffDays < 7) return `${diffDays}d ago`
    
    return date.toLocaleDateString()
  } catch {
    return timestamp
  }
}
