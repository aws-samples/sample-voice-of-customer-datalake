/**
 * @fileoverview Merge two or more memories into one statement.
 *
 * Pre-filled with the most-supported statement; the originals are archived
 * (restorable) by the server and their supporters carry over.
 *
 * @module pages/Memory/MergeModal
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import clsx from 'clsx'
import { Loader2, Merge } from 'lucide-react'
import ModalShell from '../../components/ModalShell/ModalShell'
import DialogClose from '../../components/DialogClose/DialogClose'
import { MAX_STATEMENT_CHARS } from '../../api/memoryApi'
import type { MemoryItem } from '../../api/memoryApi'

function seedStatement(items: readonly MemoryItem[]): string {
  return [...items].sort((a, b) => b.supporters - a.supporters)[0]?.statement ?? ''
}

export default function MergeModal({ items, pending, failed, onMerge, onClose }: Readonly<{
  items: readonly MemoryItem[]
  pending: boolean
  failed: boolean
  onMerge: (statement: string) => void
  onClose: () => void
}>) {
  const { t } = useTranslation('memory')
  const titleId = useId()
  const [statement, setStatement] = useState(() => seedStatement(items))
  const tooLong = statement.length > MAX_STATEMENT_CHARS

  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-2xl max-h-[90vh]">
      <div className="dialog-header justify-between">
        <div>
          <h2 id={titleId} className="dialog-title">{t('merge.title', { count: items.length })}</h2>
          <p className="dialog-description">{t('merge.description')}</p>
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body space-y-3 overflow-y-auto">
        <ul className="space-y-2">
          {items.map((m) => (
            <li key={m.memory_id} className="text-sm text-text border border-border rounded-md p-2 flex gap-2">
              <span className="flex-1">{m.statement}</span>
              <span className="font-mono text-muted text-xs">+{m.supporters}</span>
            </li>
          ))}
        </ul>
        <label className="block">
          <span className="block text-sm font-medium text-text mb-1">{t('merge.statement')}</span>
          <textarea value={statement} rows={3} onChange={(e) => setStatement(e.target.value)} aria-invalid={tooLong} className="input" />
        </label>
        <p className={clsx('text-xs font-mono text-right', tooLong ? 'text-danger' : 'text-muted')}>{statement.length}/{MAX_STATEMENT_CHARS}</p>
        {failed ? <p role="alert" className="text-xs text-danger">{t('merge.failed')}</p> : null}
      </div>
      <div className="dialog-footer">
        <button type="button" onClick={onClose} className="btn btn-secondary">{t('cancel')}</button>
        <button
          type="button"
          onClick={() => onMerge(statement.trim())}
          disabled={pending || tooLong || statement.trim() === ''}
          className="btn btn-primary flex items-center gap-1.5"
        >
          {pending ? <Loader2 size={14} className="animate-spin" /> : <Merge size={14} />} {t('merge.submit')}
        </button>
      </div>
    </ModalShell>
  )
}
