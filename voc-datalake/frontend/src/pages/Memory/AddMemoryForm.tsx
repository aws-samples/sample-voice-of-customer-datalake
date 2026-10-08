/**
 * @fileoverview "Remember this" — add a memory explicitly (`source_kind:
 * user_explicit`, which beats anything automated).
 *
 * Anyone may add a personal memory. A company memory added by someone who is
 * not a curator is stored as `proposed` by the server and shows up in review;
 * the form says so instead of pretending it went live.
 *
 * @module pages/Memory/AddMemoryForm
 */
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Loader2, Plus } from 'lucide-react'
import { isMemoryKind as isKind, isMemoryRetention as isRetention, MAX_STATEMENT_CHARS, MEMORY_KINDS, memoryApi, RETENTIONS } from '../../api/memoryApi'
import type { MemoryKind, MemoryRetention, MemoryScope } from '../../api/memoryApi'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'

export default function AddMemoryForm({ scope, canCurate, onAdded }: Readonly<{
  scope: MemoryScope
  canCurate: boolean
  onAdded: () => void
}>) {
  const { t } = useTranslation('memory')
  const [statement, setStatement] = useState('')
  const [kind, setKind] = useState<MemoryKind>(scope === 'company' ? 'product' : 'working_style')
  const [retention, setRetention] = useState<MemoryRetention>('long_term')
  const [expiresAt, setExpiresAt] = useState('')
  const add = useMutation({
    mutationFn: () => memoryApi.add({
      scope, statement: statement.trim(), kind, retention,
      ...(retention === 'dated' && expiresAt ? { expires_at: expiresAt } : {}),
    }),
    onSuccess: () => { setStatement(''); setExpiresAt(''); onAdded() },
  })
  const tooLong = statement.length > MAX_STATEMENT_CHARS
  const ready = statement.trim() !== '' && !tooLong && (retention !== 'dated' || expiresAt !== '')

  return (
    <form
      className="card p-4 space-y-2"
      onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate() }}
    >
      <label htmlFor={`memory-add-${scope}`} className="block text-sm font-medium text-text">{t(`add.label.${scope}`)}</label>
      <textarea
        id={`memory-add-${scope}`}
        value={statement}
        rows={2}
        onChange={(e) => setStatement(e.target.value)}
        placeholder={t(`add.placeholder.${scope}`)}
        aria-invalid={tooLong}
        className="input"
      />
      <StickyActionBar variant="inline" className="flex flex-col sm:flex-row sm:items-center gap-2 py-2">
        <select aria-label={t('filters.kind')} value={kind} onChange={(e) => { if (isKind(e.target.value)) setKind(e.target.value) }} className="select sm:w-44">
          {MEMORY_KINDS.map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}
        </select>
        <select aria-label={t('add.retention')} value={retention} onChange={(e) => { if (isRetention(e.target.value)) setRetention(e.target.value) }} className="select sm:w-44">
          {RETENTIONS.map((r) => <option key={r} value={r}>{t(`retention.${r}`)}</option>)}
        </select>
        {retention === 'dated' ? (
          <input type="date" aria-label={t('add.expiresAt')} value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} className="input sm:w-44" />
        ) : null}
        <span className={clsx('text-xs font-mono sm:ml-auto', tooLong ? 'text-danger' : 'text-muted')}>
          {statement.length}/{MAX_STATEMENT_CHARS}
        </span>
        <button type="submit" disabled={!ready || add.isPending} className="btn btn-primary btn-sm flex items-center justify-center gap-1.5">
          {add.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('add.submit')}
        </button>
      </StickyActionBar>
      <FormNotices scope={scope} canCurate={canCurate} failed={add.isError} saved={add.isSuccess} />
    </form>
  )
}

function FormNotices({ scope, canCurate, failed, saved }: Readonly<{ scope: MemoryScope; canCurate: boolean; failed: boolean; saved: boolean }>) {
  const { t } = useTranslation('memory')
  return (
    <>
      {scope === 'company' && !canCurate ? <p className="text-xs text-muted">{t('add.proposedNotice')}</p> : null}
      {failed ? <p role="alert" className="text-xs text-danger">{t('add.failed')}</p> : null}
      {saved ? <p role="status" className="text-xs text-ok">{t('add.saved')}</p> : null}
    </>
  )
}
