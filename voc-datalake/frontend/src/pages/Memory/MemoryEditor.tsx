/**
 * @fileoverview Inline editor for one memory's statement (`PUT /memory/{id}`):
 * a labelled textarea seeded with the saved statement, Save and Cancel. Cancel
 * (or Escape) drops the draft and the card shows the saved statement again.
 *
 * @module pages/Memory/MemoryEditor
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import clsx from 'clsx'
import { MAX_STATEMENT_CHARS } from '../../api/memoryApi'

export interface MemoryEditing {
  readonly pending: boolean
  readonly failed: boolean
  readonly onSave: (statement: string) => void
  readonly onCancel: () => void
}

export default function MemoryEditor({ statement: saved, editing }: Readonly<{ statement: string; editing: MemoryEditing }>) {
  const { t } = useTranslation('memory')
  const fieldId = useId()
  const [draft, setDraft] = useState(saved)
  const trimmed = draft.trim()
  const tooLong = draft.length > MAX_STATEMENT_CHARS
  const canSave = !editing.pending && !tooLong && trimmed !== '' && trimmed !== saved.trim()
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => { event.preventDefault(); if (canSave) editing.onSave(trimmed) }}
      onKeyDown={(event) => { if (event.key === 'Escape') editing.onCancel() }}
    >
      <label htmlFor={fieldId} className="sr-only">{t('editField')}</label>
      <textarea id={fieldId} value={draft} rows={3} autoFocus onChange={(event) => setDraft(event.target.value)}
        aria-invalid={tooLong} className="input w-full" />
      <div className="flex flex-wrap items-center justify-end gap-2">
        <span className={clsx('text-xs font-mono mr-auto', tooLong ? 'text-danger' : 'text-muted')}>{draft.length}/{MAX_STATEMENT_CHARS}</span>
        <button type="button" onClick={editing.onCancel} className="btn btn-secondary btn-sm">{t('cancel')}</button>
        <button type="submit" disabled={!canSave} className="btn btn-primary btn-sm flex items-center gap-1">
          {editing.pending ? <Loader2 size={14} className="animate-spin" aria-hidden /> : null} {t('save')}
        </button>
      </div>
      {editing.failed ? <p role="alert" className="text-xs text-danger">{t('editFailed')}</p> : null}
    </form>
  )
}
