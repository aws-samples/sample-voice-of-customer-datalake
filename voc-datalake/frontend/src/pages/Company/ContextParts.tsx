/**
 * @fileoverview Building blocks shared by the company-context, personal-context
 * and design-system sections of Settings: section header, load/error state, a
 * save row, a write/preview markdown field and the read-only badge.
 *
 * Shared rather than repeated per section so the three cards stay consistent
 * (and jscpd stays quiet).
 *
 * @module pages/Company/ContextParts
 */
import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import clsx from 'clsx'
import { AlertCircle, Check, Eye, Loader2, RefreshCw, Save } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

export function SectionHeader({ icon: Icon, title, description, aside }: Readonly<{
  icon: LucideIcon
  title: string
  description?: string
  aside?: ReactNode
}>) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-2 mb-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <Icon className="text-accent" size={16} />
          <h2 className="text-lg font-semibold tracking-tight text-text-strong">{title}</h2>
        </div>
        {description ? <p className="text-sm text-muted">{description}</p> : null}
      </div>
      {aside}
    </div>
  )
}

export function ViewOnlyBadge() {
  const { t } = useTranslation('settings')
  return (
    <span className="badge badge-muted flex items-center gap-1 self-start">
      <Eye size={12} /> {t('shared.viewOnly')}
    </span>
  )
}

/** Loading / failed state of a section's query; renders nothing once loaded. */
export function QueryState({ isLoading, isError, onRetry }: Readonly<{
  isLoading: boolean
  isError: boolean
  onRetry: () => void
}>) {
  const { t } = useTranslation('settings')
  if (isError) {
    return (
      <div role="alert" className="flex flex-col sm:flex-row sm:items-center gap-3 text-sm text-danger bg-danger-subtle border border-danger/30 p-3 rounded-lg">
        <span className="flex items-center gap-2 flex-1"><AlertCircle size={16} /> {t('shared.loadFailed')}</span>
        <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm flex items-center justify-center gap-1.5">
          <RefreshCw size={14} /> {t('shared.retry')}
        </button>
      </div>
    )
  }
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Loader2 size={14} className="animate-spin" /> {t('shared.loading')}
      </div>
    )
  }
  return null
}

/** The save button of a section, with its pending / saved / failed feedback. */
export function SaveRow({ onSave, pending, saved, failed, disabled = false, label }: Readonly<{
  onSave: () => void
  pending: boolean
  saved: boolean
  failed: boolean
  disabled?: boolean
  label?: string
}>) {
  const { t } = useTranslation('settings')
  return (
    // Sticky + registered: the full-width Save on a phone sat under the assistant launcher (3.00.00 R3).
    <StickyActionBar variant="inline" className="flex flex-col sm:flex-row sm:items-center sm:justify-end gap-2 py-3 mt-4 border-t border-border">
      {failed ? (
        <p role="alert" className="text-xs text-danger flex items-center gap-1 sm:mr-auto">
          <AlertCircle size={12} /> {t('shared.saveFailed')}
        </p>
      ) : null}
      {saved && !failed ? (
        <span role="status" className="text-xs text-ok flex items-center gap-1"><Check size={12} /> {t('saved')}</span>
      ) : null}
      <button
        type="button"
        onClick={onSave}
        disabled={pending || disabled}
        className="btn btn-primary flex items-center justify-center gap-2 w-full sm:w-auto"
      >
        {pending ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
        {pending ? t('saving') : label ?? t('saveChanges')}
      </button>
    </StickyActionBar>
  )
}

/** Rendered markdown in the shared `.md-content` style (no raw HTML). */
export function MarkdownView({ source, empty }: Readonly<{ source: string; empty: string }>) {
  if (source.trim() === '') return <p className="text-sm text-muted italic">{empty}</p>
  return (
    <div className="md-content text-sm">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  )
}

/** A markdown textarea with Write / Preview tabs and a character counter. */
export function MarkdownField({ label, value, onChange, maxChars, placeholder, rows = 8 }: Readonly<{
  label: string
  value: string
  onChange: (value: string) => void
  maxChars: number
  placeholder?: string
  rows?: number
}>) {
  const { t } = useTranslation('settings')
  const id = useId()
  const [preview, setPreview] = useState(false)
  const over = value.length > maxChars
  return (
    <div>
      <div className="flex items-center justify-between gap-2 mb-1">
        <label htmlFor={id} className="block text-sm font-medium text-text">{label}</label>
        <div className="tabs-track">
          <button type="button" className={clsx('tab', !preview && 'tab-active')} aria-pressed={!preview} onClick={() => setPreview(false)}>
            {t('shared.write')}
          </button>
          <button type="button" className={clsx('tab', preview && 'tab-active')} aria-pressed={preview} onClick={() => setPreview(true)}>
            {t('shared.preview')}
          </button>
        </div>
      </div>
      {preview ? (
        <div className="border border-border rounded-md p-3 bg-bg-accent min-h-[120px]">
          <MarkdownView source={value} empty={t('shared.nothingToPreview')} />
        </div>
      ) : (
        <textarea
          id={id}
          value={value}
          rows={rows}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          aria-invalid={over}
          className="input font-mono text-[13px]"
        />
      )}
      <p className={clsx('text-xs mt-1 font-mono text-right', over ? 'text-danger' : 'text-muted')}>
        {t('shared.charCount', { count: value.length, max: maxChars.toLocaleString() })}
      </p>
    </div>
  )
}

/** Uppercase label above a group of rows. */
export function GroupLabel({ children }: Readonly<{ children: ReactNode }>) {
  return <h3 className="text-[11px] font-semibold uppercase tracking-[.08em] text-muted-strong mb-2">{children}</h3>
}
