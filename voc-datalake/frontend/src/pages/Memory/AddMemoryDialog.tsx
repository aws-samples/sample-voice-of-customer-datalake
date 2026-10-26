/**
 * @fileoverview "Add memory" — a dialog opened from the list's button, adding a
 * memory explicitly (`source_kind: user_explicit`, which beats anything automated).
 *
 * Anyone may add a personal memory. A company memory added by someone who is not a
 * curator is stored as `proposed` by the server and goes to review; the dialog says
 * so up front. Personal data the server will hide (emails, phone numbers,
 * credentials) is named BEFORE saving (`privacyPreview`), so the stored text never
 * changes behind the user's back.
 *
 * @module pages/Memory/AddMemoryDialog
 */
import { useId, useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Loader2, Plus, ShieldCheck } from 'lucide-react'
import ModalShell from '../../components/ModalShell/ModalShell'
import DialogClose from '../../components/DialogClose/DialogClose'
import { isMemoryKind as isKind, isMemoryRetention as isRetention, MAX_STATEMENT_CHARS, MEMORY_KINDS, memoryApi, RETENTIONS } from '../../api/memoryApi'
import type { MemoryItem, MemoryKind, MemoryRetention, MemoryScope } from '../../api/memoryApi'
import { detailsToHide } from './privacyPreview'

/** Names what the server will hide, before the user saves. */
function PrivacyNotice({ statement }: Readonly<{ statement: string }>) {
  const { t } = useTranslation('memory')
  const hidden = detailsToHide(statement)
  if (hidden.length === 0) return null
  return (
    <div role="status" className="text-xs text-text bg-info-subtle border border-info/30 rounded-md p-2 space-y-1">
      <p className="flex items-center gap-1.5 font-medium"><ShieldCheck size={14} aria-hidden /> {t('privacy.beforeSave')}</p>
      <ul className="flex flex-wrap gap-1">
        {hidden.map((part) => <li key={part} className="badge badge-muted font-mono">{part}</li>)}
      </ul>
    </div>
  )
}

function RetentionField({ retention, expiresAt, onRetention, onExpiresAt }: Readonly<{
  retention: MemoryRetention; expiresAt: string
  onRetention: (r: MemoryRetention) => void; onExpiresAt: (d: string) => void
}>) {
  const { t } = useTranslation('memory')
  const hintId = useId()
  return (
    <div className="space-y-1">
      <div className="flex flex-col sm:flex-row gap-2">
        <label className="flex-1">
          <span className="block text-xs text-muted mb-1">{t('add.retention')}</span>
          <select aria-describedby={hintId} value={retention} onChange={(e) => { if (isRetention(e.target.value)) onRetention(e.target.value) }} className="select w-full">
            {RETENTIONS.map((r) => <option key={r} value={r}>{t(`retention.${r}`)}</option>)}
          </select>
        </label>
        {retention === 'dated' ? (
          <label className="flex-1">
            <span className="block text-xs text-muted mb-1">{t('add.expiresAt')}</span>
            <input type="date" value={expiresAt} onChange={(e) => onExpiresAt(e.target.value)} className="input w-full" />
          </label>
        ) : null}
      </div>
      <p id={hintId} className="text-xs text-muted">{t(`retentionHint.${retention}`)}</p>
    </div>
  )
}

export default function AddMemoryDialog({ scope, canCurate, onAdded, onClose }: Readonly<{
  scope: MemoryScope
  canCurate: boolean
  onAdded: (item: MemoryItem | null) => void
  onClose: () => void
}>) {
  const { t } = useTranslation('memory')
  const titleId = useId()
  const [statement, setStatement] = useState('')
  const [kind, setKind] = useState<MemoryKind>(scope === 'company' ? 'product' : 'working_style')
  const [retention, setRetention] = useState<MemoryRetention>('long_term')
  const [expiresAt, setExpiresAt] = useState('')
  const add = useMutation({
    mutationFn: () => memoryApi.add({
      scope, statement: statement.trim(), kind, retention,
      ...(retention === 'dated' && expiresAt ? { expires_at: expiresAt } : {}),
    }),
    onSuccess: (item) => { onAdded(item); onClose() },
  })
  const tooLong = statement.length > MAX_STATEMENT_CHARS
  const ready = statement.trim() !== '' && !tooLong && (retention !== 'dated' || expiresAt !== '')

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-lg max-h-[90vh]" dismissable={!add.isPending}>
      <form className="contents" onSubmit={(e) => { e.preventDefault(); if (ready) add.mutate() }}>
        <div className="dialog-header justify-between">
          <h2 id={titleId} className="dialog-title">{t(`add.label.${scope}`)}</h2>
          <DialogClose onClick={onClose} disabled={add.isPending} />
        </div>
        <div className="dialog-body space-y-3 overflow-y-auto">
          <label className="block">
            <span className="block text-sm font-medium text-text mb-1">{t('add.statement')}</span>
            <textarea value={statement} rows={3} autoFocus onChange={(e) => setStatement(e.target.value)}
              placeholder={t(`add.placeholder.${scope}`)} aria-invalid={tooLong} className="input" />
          </label>
          <p className={clsx('text-xs font-mono text-right', tooLong ? 'text-danger' : 'text-muted')}>{statement.length}/{MAX_STATEMENT_CHARS}</p>
          <PrivacyNotice statement={statement} />
          <label className="block">
            <span className="block text-xs text-muted mb-1">{t('filters.kind')}</span>
            <select value={kind} onChange={(e) => { if (isKind(e.target.value)) setKind(e.target.value) }} className="select w-full">
              {MEMORY_KINDS.map((k) => <option key={k} value={k}>{t(`kind.${k}`)}</option>)}
            </select>
          </label>
          <RetentionField retention={retention} expiresAt={expiresAt} onRetention={setRetention} onExpiresAt={setExpiresAt} />
          {scope === 'company' && !canCurate ? <p className="text-xs text-muted">{t('add.proposedNotice')}</p> : null}
          {add.isError ? <p role="alert" className="text-xs text-danger">{t('add.failed')}</p> : null}
        </div>
        <div className="dialog-footer">
          <button type="button" onClick={onClose} disabled={add.isPending} className="btn btn-secondary">{t('cancel')}</button>
          <button type="submit" disabled={!ready || add.isPending} className="btn btn-primary flex items-center gap-1.5">
            {add.isPending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} {t('add.submit')}
          </button>
        </div>
      </form>
    </ModalShell>
  )
}
