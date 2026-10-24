/**
 * @fileoverview Logs section for Settings page.
 * @module pages/Settings/LogsSection
 * 
 * Displays validation failures, processing errors, and scraper logs.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { 
  AlertTriangle, XCircle, RefreshCw, Trash2,
  FileWarning, Loader2, AlertCircle,
} from 'lucide-react'
import { api } from '../../api/client'
import type { ProcessingLogEntry } from '../../api/types'
import { ADMIN_ONLY_TITLE } from '../../constants/admin'
import { formatCount } from '../../utils/numberFormat'
import { useIsAdmin } from '../../store/authStore'
import clsx from 'clsx'
import type { Tone } from '../../theme/tones'
import { SourceLogPanel } from './SourceLogList'
import { TabsTrack } from './TabsTrack'
import AlertsCard from './AlertsCard'
import ScraperLogsPanel from './ScraperRunsPanel'
import type { LogEntryView } from './SourceLogList'

type LogTab = 'validation' | 'processing' | 'scrapers'

interface LogsSectionProps {
  readonly apiEndpoint: string
}

// min-w-0 + hyphens: a long one-word title (de "Quelleneinstellungen") wraps beside its icon at 200 % text.
const SECTION_TITLE = 'min-w-0 break-words hyphens-auto text-lg font-semibold tracking-tight text-text-strong'

export default function LogsSection({ apiEndpoint }: LogsSectionProps) {
  const { t } = useTranslation('settings')
  const [activeTab, setActiveTab] = useState<LogTab>('validation')
  const [days, setDays] = useState(7)

  if (!apiEndpoint) {
    return (
      <div className="card">
        <div className="flex items-center gap-2 mb-4">
          <FileWarning className="text-warn" size={16} />
          <h2 className={SECTION_TITLE}>{t('logs.title')}</h2>
        </div>
        <div className="flex items-start gap-2 text-sm text-warn bg-warn-subtle border border-warn/30 p-3 rounded-lg">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{t('logs.configureFirst')}</span>
        </div>
      </div>
    )
  }

  const tabs = [
    { id: 'validation' as const, label: t('logs.validationFailures'), icon: AlertTriangle },
    { id: 'processing' as const, label: t('logs.processingErrors'), icon: XCircle },
    { id: 'scrapers' as const, label: t('logs.scraperRuns'), icon: RefreshCw },
  ]

  return (
    <div className="space-y-4">
      <div className="card">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2">
            <FileWarning className="text-warn" size={16} />
            <h2 className={SECTION_TITLE}>{t('logs.title')}</h2>
          </div>
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            aria-label={t('logs.periodLabel')}
            title={t('logs.periodLabel')}
            className="select-sm select w-auto"
          >
            <option value={1}>{t('logs.last24Hours')}</option>
            <option value={7}>{t('logs.last7Days')}</option>
            <option value={30}>{t('logs.last30Days')}</option>
          </select>
        </div>

        <LogsSummaryCard days={days} />

        {/* Tab Navigation */}
        <TabsTrack tabs={tabs} active={activeTab} onSelect={setActiveTab} className="mt-4" />
      </div>

      <AlertsCard />

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
  readonly colorScheme: Extract<Tone, 'warn' | 'danger'>
}

function SummaryCardItem({ count, label, icon: Icon, colorScheme }: SummaryCardItemProps) {
  const { i18n } = useTranslation()
  const hasIssues = count > 0

  // Determine classes based on state
  const getContainerClass = () => {
    if (!hasIssues) return 'bg-ok-subtle border border-ok/30'
    if (colorScheme === 'warn') return 'bg-warn-subtle border border-warn/30'
    return 'bg-danger-subtle border border-danger/30'
  }

  // Icon and count share one status colour.
  const getStatusTextClass = () => {
    if (!hasIssues) return 'text-ok'
    if (colorScheme === 'warn') return 'text-warn'
    return 'text-danger'
  }

  return (
    <div className={clsx('p-3 rounded-lg', getContainerClass())}>
      <div className="flex items-center gap-2 mb-1">
        <Icon size={16} className={getStatusTextClass()} />
        <span className="min-w-0 text-sm font-medium text-text break-words hyphens-auto">{label}</span>
      </div>
      <p className={clsx('text-2xl font-bold font-mono', getStatusTextClass())}>
        {formatCount(count, i18n.language)}
      </p>
    </div>
  )
}

function LogsSummaryCard({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')
  const { data, isLoading } = useQuery({
    queryKey: ['logs-summary', days],
    queryFn: () => api.getLogsSummary(days),
    refetchInterval: 30000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" />
        {t('logs.loadingSummary')}
      </div>
    )
  }

  const summary = data?.summary
  const totalValidation = summary?.total_validation_failures ?? 0
  const totalProcessing = summary?.total_processing_errors ?? 0

  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3 sm:gap-4">
      <SummaryCardItem 
        count={totalValidation} 
        label={t('logs.validationFailures')} 
        icon={AlertTriangle} 
        colorScheme="warn" 
      />
      <SummaryCardItem 
        count={totalProcessing} 
        label={t('logs.processingErrors')} 
        icon={XCircle} 
        colorScheme="danger" 
      />
    </div>
  )
}

// ============================================
// Validation / Processing Logs Panels
// ============================================

/**
 * A validation-failure row as rendered. `GET /logs/validation` no longer sends the
 * record's raw preview (it carried submitter email/name and the review text, and
 * the route is open to every user — decision 3); it sends the record's SHAPE
 * instead. Parsed leniently at the boundary, and `z.object` strips unknown keys,
 * so an older API that still sends `raw_preview` cannot get it rendered.
 */
const ValidationLogSchema = z.object({
  source_platform: z.string().catch('unknown'),
  message_id: z.string().catch(''),
  timestamp: z.string().catch(''),
  errors: z.array(z.string()).catch([]),
  record_keys: z.array(z.string()).optional().catch(undefined),
  text_length: z.number().int().nonnegative().optional().catch(undefined),
})
type ValidationLogView = z.infer<typeof ValidationLogSchema>

function toValidationLogs(raw: readonly unknown[]): ValidationLogView[] {
  return raw.flatMap((entry) => {
    const parsed = ValidationLogSchema.safeParse(entry)
    return parsed.success ? [parsed.data] : []
  })
}

const VALIDATION_VIEW: LogEntryView<ValidationLogView> = {
  summary: (log) => <>
    <AlertTriangle size={14} className="text-warn flex-shrink-0" />
    <span className="text-sm font-mono text-text truncate" title={log.message_id}>{log.message_id}</span>
  </>,
  detail: (log) => <ValidationLogDetail log={log} />,
}

function ValidationLogDetail({ log }: { readonly log: ValidationLogView }) {
  const { t } = useTranslation('settings')
  return <>
    <div className="mb-2">
      <span className="font-medium text-text">{t('logs.errorsLabel')}</span>
      <ul className="mt-1 list-disc list-inside text-danger">
        {log.errors.map((err, i) => <li key={i}>{err}</li>)}
      </ul>
    </div>
    {log.record_keys !== undefined && log.record_keys.length > 0 && (
      <div className="mb-2">
        <span className="font-medium text-text">{t('logs.recordKeys')}</span>
        <span className="ml-2 font-mono text-xs text-text break-all">{log.record_keys.join(', ')}</span>
      </div>
    )}
    {log.text_length !== undefined && (
      <p className="text-muted">{t('logs.textLength', { count: log.text_length })}</p>
    )}
  </>
}

function ValidationLogsPanel({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  // `DELETE /logs/validation/{source}` is admin-only server-side (logs_handler.py);
  // the disabled control only explains the 403 it would get.
  const isAdmin = useIsAdmin()

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['validation-logs', days],
    queryFn: () => api.getValidationLogs({ days, limit: 100 }),
  })

  const clearMutation = useMutation({
    mutationFn: (source: string) => api.clearValidationLogs(source),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['validation-logs'] })
      void queryClient.invalidateQueries({ queryKey: ['logs-summary'] })
    },
  })

  return (
    <SourceLogPanel
      isLoading={isLoading}
      logs={toValidationLogs(data?.logs ?? [])}
      emptyMessage={t('logs.noValidationFailures')}
      onRefresh={() => void refetch()}
      view={VALIDATION_VIEW}
      badge={(count) => <span className="badge badge-warn font-mono">{t('logs.failures', { count })}</span>}
      action={(source) => (
        <button
          type="button"
          onClick={() => { if (isAdmin) clearMutation.mutate(source) }}
          disabled={!isAdmin || clearMutation.isPending}
          title={isAdmin ? undefined : ADMIN_ONLY_TITLE}
          className="btn btn-secondary btn-sm flex items-center gap-1.5"
        >
          {clearMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
          {t('logs.clear')}
        </button>
      )}
    />
  )
}

const PROCESSING_VIEW: LogEntryView<ProcessingLogEntry> = {
  summary: (log) => <>
    <XCircle size={14} className="text-danger flex-shrink-0" />
    <span className="text-sm font-medium text-danger truncate" title={log.error_type}>{log.error_type}</span>
  </>,
  detail: (log) => <ProcessingLogDetail log={log} />,
}

function ProcessingLogDetail({ log }: { readonly log: ProcessingLogEntry }) {
  const { t } = useTranslation('settings')
  return <>
    <div className="mb-2">
      <span className="font-medium text-text">{t('logs.messageId')}</span>
      <span className="ml-2 font-mono text-text break-all">{log.message_id}</span>
    </div>
    <div>
      <span className="font-medium text-text">{t('logs.errorLabel')}</span>
      <p className="mt-1 text-danger">{log.error_message}</p>
    </div>
  </>
}

function ProcessingLogsPanel({ days }: { readonly days: number }) {
  const { t } = useTranslation('settings')

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['processing-logs', days],
    queryFn: () => api.getProcessingLogs({ days, limit: 100 }),
  })

  return (
    <SourceLogPanel
      isLoading={isLoading}
      logs={data?.logs ?? []}
      emptyMessage={t('logs.noProcessingErrors')}
      onRefresh={() => void refetch()}
      view={PROCESSING_VIEW}
      badge={(count) => <span className="badge badge-danger font-mono">{t('logs.errors', { count })}</span>}
    />
  )
}
