/**
 * @fileoverview The System errors tab's "Failure queues" card
 * (`GET /logs/system/queues`): every dead-letter / failure queue that holds
 * messages — its depth, the age of its oldest message, and (expanded) up to three
 * redacted sample bodies. A message there is work that failed every retry and
 * will not be retried again.
 * @module pages/Settings/SystemFailureQueues
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CheckCircle, ChevronDown, Inbox } from 'lucide-react'
import clsx from 'clsx'
import type { SystemFailureQueue } from '../../api/systemDiagnostics'
import { SettingsLoading, SettingsNotice } from './SettingsNotice'
import { formatTimestamp } from './logsFormat'
import { useSystemFailureQueues } from './useSystemLogs'

export default function SystemFailureQueues() {
  const { t } = useTranslation('settings')
  const { data, isLoading, isError } = useSystemFailureQueues()

  return (
    <section aria-labelledby="system-failure-queues" className="card space-y-2">
      <h3 id="system-failure-queues" className="flex items-center gap-2 text-sm font-medium text-text-strong">
        <Inbox size={16} aria-hidden="true" />
        {t('logs.system.queues.title')}
      </h3>
      <QueuesBody isLoading={isLoading} isError={isError} queues={data?.queues} />
    </section>
  )
}

function QueuesBody({ isLoading, isError, queues }: Readonly<{
  isLoading: boolean
  isError: boolean
  queues: readonly SystemFailureQueue[] | undefined
}>) {
  const { t } = useTranslation('settings')
  if (isLoading) return <SettingsLoading text={t('logs.system.queues.loading')} />
  if (isError || queues === undefined) return <SettingsNotice text={t('logs.system.queues.loadFailed')} />
  // An unreadable queue (messages: null) is shown, never counted as empty.
  const holding = queues.filter((queue) => queue.messages === null || queue.messages > 0)
  if (holding.length === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <CheckCircle size={14} className="text-success" aria-hidden="true" />
        {t('logs.system.queues.empty', { count: queues.length })}
      </p>
    )
  }
  return (
    <ul className="space-y-2">
      {holding.map((queue) => <QueueRow key={queue.name} queue={queue} />)}
    </ul>
  )
}

/** When the oldest message arrived, from its age in seconds. */
const oldestAt = (ageSeconds: number) => new Date(Date.now() - ageSeconds * 1000).toISOString()

function QueueRow({ queue }: { readonly queue: SystemFailureQueue }) {
  const { t, i18n } = useTranslation('settings')
  const [open, setOpen] = useState(false)
  return (
    <li className="border border-border rounded-lg overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        className="w-full flex items-center justify-between gap-3 p-2 text-left hover:bg-bg-hover"
      >
        <span className="text-xs font-mono text-text-strong truncate" title={queue.name}>{queue.name}</span>
        <span className="flex items-center gap-2 flex-shrink-0 text-xs text-muted">
          {queue.messages === null
            ? <span className="badge badge-warn">{t('logs.system.queues.unreadable')}</span>
            : <span className="badge badge-danger font-mono">{t('logs.system.queues.messages', { count: queue.messages })}</span>}
          {queue.oldest_age_seconds !== undefined && (
            <span>{t('logs.system.queues.oldest', { age: formatTimestamp(oldestAt(queue.oldest_age_seconds), t, i18n.language) })}</span>
          )}
          <ChevronDown size={14} className={clsx('transition-transform', open && 'rotate-180')} aria-hidden="true" />
        </span>
      </button>
      {open && <QueueSamples samples={queue.sample} />}
    </li>
  )
}

function QueueSamples({ samples }: { readonly samples: readonly string[] }) {
  const { t } = useTranslation('settings')
  return (
    <div className="p-2 bg-bg-accent border-t border-border space-y-2">
      {samples.length === 0
        ? <p className="text-xs text-muted">{t('logs.system.queues.noSample')}</p>
        : samples.map((body, position) => (
          <pre
            // Samples are the newest first and have no id; position plus a prefix of the body keys them.
            key={`${String(position)}:${body.slice(0, 32)}`}
            className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-text"
          >{body}</pre>
        ))}
      <p className="text-xs text-muted">{t('logs.system.queues.peekNote')}</p>
    </div>
  )
}
