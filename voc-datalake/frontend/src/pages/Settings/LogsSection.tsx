/**
 * @fileoverview Logs section for Settings page.
 * @module pages/Settings/LogsSection
 *
 * Displays validation failures, processing errors, and scraper logs.
 */

import {
  useQuery, useMutation, useQueryClient,
} from '@tanstack/react-query'
import clsx from 'clsx'
import {
  AlertTriangle, XCircle, RefreshCw, Trash2, ChevronDown,
  FileWarning, Loader2, CheckCircle, AlertCircle,
} from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { api } from '../../api/client'
import { formatTimestamp } from './logsHelpers'
import {
  LogsLoadingState, LogsEmptyState,
} from './logsUtils'
import { ScraperLogsPanel } from './ScraperLogsPanel'
import type {
  ValidationLogEntry, ProcessingLogEntry,
} from '../../api/types'

type LogTab = 'validation' | 'processing' | 'scrapers'

interface LogsSectionProps { readonly apiEndpoint: string }

export default function LogsSection({ apiEndpoint }: LogsSectionProps) {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] = useState<LogTab>('validation')
  const [days, setDays] = useState(7)

  if (apiEndpoint === '') {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <FileWarning className="text-amber-600" size={20} />
          <h2 className="text-lg font-semibold">{t('logs.title')}</h2>
        </div>
        <div className="flex items-start gap-2 text-sm text-amber-600 bg-amber-50 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{t('logs.configureFirst')}</span>
        </div>
      </div>
    )
  }

  const tabs = [
    {
      id: 'validation' as const,
      label: t('logs.validationFailures'),
      icon: AlertTriangle,
    },
    {
      id: 'processing' as const,
      label: t('logs.processingErrors'),
      icon: XCircle,
    },
    {
      id: 'scrapers' as const,
      label: t('logs.scraperRuns'),
      icon: RefreshCw,
    },
  ]

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <FileWarning className="text-amber-600" size={20} />
            <h2 className="text-lg font-semibold">{t('logs.title')}</h2>
          </div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="input w-auto text-sm"
          >
            <option value={1}>{t('logs.last24Hours')}</option>
            <option value={7}>{t('logs.last7Days')}</option>
            <option value={30}>{t('logs.last30Days')}</option>
          </select>
        </div>

        <LogsSummaryCard days={days} />

        <div className="flex border-b border-gray-200 mt-4">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={clsx(
                'flex items-center gap-2 px-3 py-2 text-sm border-b-2 -mb-px transition-colors',
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700',
              )}
            >
              <tab.icon size={16} />
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {activeTab === 'validation' && <ValidationLogsPanel days={days} />}
      {activeTab === 'processing' && <ProcessingLogsPanel days={days} />}
      {activeTab === 'scrapers' && <ScraperLogsPanel days={days} />}
    </div>
  )
}

interface SummaryCardItemProps {
  readonly count: number
  readonly label: string
  readonly icon: typeof AlertTriangle
  readonly colorScheme: 'amber' | 'red'
}

function SummaryCardItem({
  count, label, icon: summaryIcon, colorScheme,
}: SummaryCardItemProps) {
  const hasIssues = count > 0

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

  const IconComponent = summaryIcon

  return (
    <div className={clsx('p-3 rounded-lg', getContainerClass())}>
      <div className="flex items-center gap-2 mb-1">
        <IconComponent size={16} className={getIconColorClass()} />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <p className={clsx('text-2xl font-bold', getCountColorClass())}>{count}</p>
    </div>
  )
}

function LogsSummaryCard({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')
  const {
    data, isLoading,
  } = useQuery({
    queryKey: ['logs-summary', days],
    queryFn: () => api.getLogsSummary(days),
    refetchInterval: 30000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-500">
        <Loader2 size={16} className="animate-spin" />
        {t('logs.loadingSummary')}
      </div>
    )
  }

  const summary = data?.summary
  const totalValidation = summary?.total_validation_failures ?? 0
  const totalProcessing = summary?.total_processing_errors ?? 0

  return (
    <div className="grid grid-cols-2 gap-4">
      <SummaryCardItem count={totalValidation} label={t('logs.validationFailures')} icon={AlertTriangle} colorScheme="amber" />
      <SummaryCardItem count={totalProcessing} label={t('logs.processingErrors')} icon={XCircle} colorScheme="red" />
    </div>
  )
}

function ValidationLogsPanel({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  const {
    data, isLoading, refetch,
  } = useQuery({
    queryKey: ['validation-logs', days],
    queryFn: () => api.getValidationLogs({
      days,
      limit: 100,
    }),
  })

  const clearMutation = useMutation({
    mutationFn: (source: string) => api.clearValidationLogs(source),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['validation-logs'] })
      void queryClient.invalidateQueries({ queryKey: ['logs-summary'] })
    },
  })

  if (isLoading) return <LogsLoadingState />

  const logs = data?.logs ?? []
  if (logs.length === 0) return <LogsEmptyState message={t('logs.noValidationFailures')} icon={CheckCircle} />

  const groupedLogs = logs.reduce<Record<string, ValidationLogEntry[]>>((acc, log) => {
    const source = log.source_platform
    acc[source] ??= []
    acc[source].push(log)
    return acc
  }, {})

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => {
          void refetch()
        }} className="btn btn-secondary text-sm flex items-center gap-1">
          <RefreshCw size={14} /> {t('logs.refresh')}
        </button>
      </div>
      {Object.entries(groupedLogs).map(([source, sourceLogs]) => (
        <ValidationSourceGroup
          key={source}
          source={source}
          logs={sourceLogs}
          expandedLog={expandedLog}
          onToggleExpand={setExpandedLog}
          clearMutation={clearMutation}
        />
      ))}
    </div>
  )
}

function ValidationSourceGroup({
  source, logs, expandedLog, onToggleExpand, clearMutation,
}: {
  readonly source: string
  readonly logs: ValidationLogEntry[]
  readonly expandedLog: string | null
  readonly onToggleExpand: (key: string | null) => void
  readonly clearMutation: {
    isPending: boolean;
    mutate: (source: string) => void
  }
}) {
  const { t } = useTranslation('settings')
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="font-medium">{source}</span>
          <span className="text-xs bg-amber-100 text-amber-700 px-2 py-0.5 rounded-full">
            {t('logs.failures', { count: logs.length })}
          </span>
        </div>
        <button onClick={() => clearMutation.mutate(source)} disabled={clearMutation.isPending} className="btn btn-secondary text-xs flex items-center gap-1">
          {clearMutation.isPending ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          {t('logs.clear')}
        </button>
      </div>
      <div className="space-y-2">
        {logs.slice(0, 5).map((log, idx) => {
          const logKey = `${log.source_platform}-${log.message_id}-${idx}`
          const isExpanded = expandedLog === logKey
          return (
            <div key={logKey} className="border border-gray-200 rounded-lg overflow-hidden">
              <button onClick={() => onToggleExpand(isExpanded ? null : logKey)} className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50">
                <div className="flex items-center gap-2 min-w-0">
                  <AlertTriangle size={14} className="text-amber-500 flex-shrink-0" />
                  <span className="text-sm truncate">{log.message_id}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-500">{formatTimestamp(log.timestamp, t)}</span>
                  <ChevronDown size={14} className={clsx('text-gray-400 transition-transform', isExpanded && 'rotate-180')} />
                </div>
              </button>
              {isExpanded ? <div className="p-3 bg-gray-50 border-t border-gray-200 text-sm">
                <div className="mb-2">
                  <span className="font-medium text-gray-700">{t('logs.errorsLabel')}</span>
                  <ul className="mt-1 list-disc list-inside text-red-600">
                    {log.errors.map((err) => <li key={err.slice(0, 80)}>{err}</li>)}
                  </ul>
                </div>
                {log.raw_preview != null && log.raw_preview !== '' ? <div>
                  <span className="font-medium text-gray-700">{t('logs.rawPreview')}</span>
                  <pre className="mt-1 p-2 bg-gray-100 rounded text-xs overflow-x-auto">{log.raw_preview}</pre>
                </div> : null}
              </div> : null}
            </div>
          )
        })}
        {logs.length > 5 && (
          <p className="text-xs text-gray-500 text-center py-2">{t('logs.moreEntries', { count: logs.length - 5 })}</p>
        )}
      </div>
    </div>
  )
}

function ProcessingLogsPanel({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')
  const [expandedLog, setExpandedLog] = useState<string | null>(null)

  const {
    data, isLoading, refetch,
  } = useQuery({
    queryKey: ['processing-logs', days],
    queryFn: () => api.getProcessingLogs({
      days,
      limit: 100,
    }),
  })

  if (isLoading) return <LogsLoadingState />

  const logs = data?.logs ?? []
  if (logs.length === 0) return <LogsEmptyState message={t('logs.noProcessingErrors')} icon={CheckCircle} />

  const groupedLogs = logs.reduce<Record<string, ProcessingLogEntry[]>>((acc, log) => {
    const source = log.source_platform
    acc[source] ??= []
    acc[source].push(log)
    return acc
  }, {})

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <button onClick={() => {
          void refetch()
        }} className="btn btn-secondary text-sm flex items-center gap-1">
          <RefreshCw size={14} /> {t('logs.refresh')}
        </button>
      </div>
      {Object.entries(groupedLogs).map(([source, sourceLogs]) => (
        <div key={source} className="card">
          <div className="flex items-center gap-2 mb-3">
            <span className="font-medium">{source}</span>
            <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded-full">
              {t('logs.errors', { count: sourceLogs.length })}
            </span>
          </div>
          <div className="space-y-2">
            {sourceLogs.slice(0, 5).map((log, idx) => {
              const logKey = `${log.source_platform}-${log.message_id}-${idx}`
              const isExpanded = expandedLog === logKey
              return (
                <div key={logKey} className="border border-gray-200 rounded-lg overflow-hidden">
                  <button onClick={() => setExpandedLog(isExpanded ? null : logKey)} className="w-full flex items-center justify-between p-3 text-left hover:bg-gray-50">
                    <div className="flex items-center gap-2 min-w-0">
                      <XCircle size={14} className="text-red-500 flex-shrink-0" />
                      <span className="text-sm font-medium text-red-700">{log.error_type}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-500">{formatTimestamp(log.timestamp, t)}</span>
                      <ChevronDown size={14} className={clsx('text-gray-400 transition-transform', isExpanded && 'rotate-180')} />
                    </div>
                  </button>
                  {isExpanded ? <div className="p-3 bg-gray-50 border-t border-gray-200 text-sm">
                    <div className="mb-2">
                      <span className="font-medium text-gray-700">{t('logs.messageId')}</span>
                      <span className="ml-2 text-gray-600">{log.message_id}</span>
                    </div>
                    <div>
                      <span className="font-medium text-gray-700">{t('logs.errorLabel')}</span>
                      <p className="mt-1 text-red-600">{log.error_message}</p>
                    </div>
                  </div> : null}
                </div>
              )
            })}
            {sourceLogs.length > 5 && (
              <p className="text-xs text-gray-500 text-center py-2">{t('logs.moreEntries', { count: sourceLogs.length - 5 })}</p>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}
