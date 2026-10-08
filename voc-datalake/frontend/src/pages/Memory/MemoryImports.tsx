/**
 * @fileoverview Imports (curators): paste a page — title, optional URL and up to
 * 200k characters of content — for the extractor to learn from. Memories it
 * yields publish immediately under the usual confidence rules; the original is
 * kept in the raw bucket.
 *
 * Below the form: the imports this browser submitted, each polled every 3 s
 * until it finishes.
 *
 * @module pages/Memory/MemoryImports
 */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { CheckCircle2, Loader2, Upload, XCircle } from 'lucide-react'
import { isTerminalImport, MAX_IMPORT_CHARS, memoryApi, memoryKeys } from '../../api/memoryApi'
import type { ImportStatus } from '../../api/memoryApi'
import { readImportHistory, rememberImport } from './importHistory'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

const POLL_MS = 3000

const STATUS_TONE: Record<ImportStatus, string> = {
  queued: 'badge-muted', processing: 'badge-info', completed: 'badge-ok', failed: 'badge-danger',
}

export default function MemoryImports() {
  const { t } = useTranslation('memory')
  const [history, setHistory] = useState<string[]>(readImportHistory)
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [content, setContent] = useState('')
  const submit = useMutation({
    mutationFn: () => memoryApi.createImport({
      title: title.trim(), content, ...(url.trim() ? { url: url.trim() } : {}),
    }),
    onSuccess: (record) => {
      if (record) setHistory(rememberImport(record.import_id))
      setTitle(''); setUrl(''); setContent('')
    },
  })
  const tooLong = content.length > MAX_IMPORT_CHARS
  const urlInvalid = url.trim() !== '' && !/^https?:\/\//.test(url.trim())
  const ready = title.trim() !== '' && content.trim() !== '' && !tooLong && !urlInvalid

  return (
    <div className="space-y-4">
      <form className="card space-y-3" onSubmit={(e) => { e.preventDefault(); if (ready) submit.mutate() }}>
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-text-strong">{t('imports.title')}</h2>
          <p className="text-sm text-muted">{t('imports.description')}</p>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input aria-label={t('imports.pageTitle')} placeholder={t('imports.pageTitle')} value={title} onChange={(e) => setTitle(e.target.value)} className="input flex-1" />
          <input type="url" aria-label={t('imports.url')} placeholder={t('imports.url')} value={url} onChange={(e) => setUrl(e.target.value)} aria-invalid={urlInvalid} className="input flex-1" />
        </div>
        <textarea
          aria-label={t('imports.content')}
          placeholder={t('imports.contentPlaceholder')}
          value={content}
          rows={10}
          onChange={(e) => setContent(e.target.value)}
          aria-invalid={tooLong}
          className="input font-mono text-[13px]"
        />
        <StickyActionBar variant="inline" className="flex items-center justify-between gap-2 py-2">
          <span className={clsx('text-xs font-mono', tooLong ? 'text-danger' : 'text-muted')}>
            {t('imports.counter', { count: content.length, max: MAX_IMPORT_CHARS.toLocaleString() })}
          </span>
          <button type="submit" disabled={!ready || submit.isPending} className="btn btn-primary flex items-center gap-1.5">
            {submit.isPending ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} {t('imports.submit')}
          </button>
        </StickyActionBar>
        {submit.isError ? <p role="alert" className="text-xs text-danger">{t('imports.failed')}</p> : null}
      </form>

      <div className="card">
        <h3 className="text-sm font-semibold tracking-tight text-text-strong mb-2">{t('imports.history')}</h3>
        {history.length === 0 ? <p className="text-sm text-muted">{t('imports.noHistory')}</p> : (
          <ul className="divide-y divide-border">
            {history.map((id) => <ImportRow key={id} importId={id} />)}
          </ul>
        )}
      </div>
    </div>
  )
}

function ImportRow({ importId }: Readonly<{ importId: string }>) {
  const { t } = useTranslation('memory')
  const query = useQuery({
    queryKey: memoryKeys.import(importId),
    queryFn: () => memoryApi.getImport(importId),
    // Stop on a finished import, and on an error (an unknown id would poll forever).
    refetchInterval: (q) => (q.state.status === 'error' || (q.state.data && isTerminalImport(q.state.data)) ? false : POLL_MS),
    retry: false,
  })
  const record = query.data
  if (!record) {
    return (
      <li className="py-2 text-sm text-muted flex items-center gap-2">
        {query.isError ? <XCircle size={14} className="text-danger" /> : <Loader2 size={14} className="animate-spin" />}
        <span className="font-mono">{importId}</span>
      </li>
    )
  }
  return (
    <li className="py-2 flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3">
      <span className="text-sm text-text-strong flex-1 truncate">{record.title || importId}</span>
      {record.status === 'completed' ? (
        <span className="text-xs text-muted flex items-center gap-1"><CheckCircle2 size={12} className="text-ok" /> {t('imports.created', { count: record.memories_created })}</span>
      ) : null}
      {record.error ? <span className="text-xs text-danger truncate">{record.error}</span> : null}
      <span className={clsx('badge', STATUS_TONE[record.status])}>{t(`imports.status.${record.status}`)}</span>
    </li>
  )
}
