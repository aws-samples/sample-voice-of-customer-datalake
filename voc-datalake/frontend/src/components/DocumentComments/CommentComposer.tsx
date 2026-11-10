/**
 * @fileoverview A comment or reply box: a textarea, Send and Cancel. Keeps the text when the save
 * fails (the error is shown, the person retries).
 *
 * @module components/DocumentComments/CommentComposer
 */
import { Loader2, Send } from 'lucide-react'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { serverReason } from '../../lib/errors'

/** = MAX_COMMENT_CHARS / MAX_REPLY_CHARS in lambda/shared/document_comments.py. */
const MAX_COMMENT_CHARS = 2000

interface CommentComposerProps {
  readonly label: string
  readonly submitLabel: string
  readonly onSubmit: (text: string) => Promise<unknown>
  readonly onCancel?: () => void
  readonly autoFocus?: boolean
}

export default function CommentComposer({ label, submitLabel, onSubmit, onCancel, autoFocus = false }: CommentComposerProps) {
  const { t } = useTranslation('components')
  const id = useId()
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    if (text.trim() === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit(text.trim())
      setText('')
    } catch (failure) {
      setError(serverReason(failure) ?? t('documentComments.saveFailed'))
    } finally {
      setBusy(false)
    }
  }
  return (
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void submit() }}>
      <label htmlFor={id} className="sr-only">{label}</label>
      <textarea
        id={id}
        className="input text-sm"
        rows={3}
        maxLength={MAX_COMMENT_CHARS}
        placeholder={label}
        value={text}
        autoFocus={autoFocus}
        onChange={(event) => setText(event.target.value)}
      />
      {error === null ? null : <p role="alert" className="text-xs text-danger">{error}</p>}
      <div className="flex justify-end gap-2">
        {onCancel === undefined ? null : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>{t('documentComments.cancel')}</button>
        )}
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || text.trim() === ''}>
          {busy ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Send size={14} aria-hidden />}
          {submitLabel}
        </button>
      </div>
    </form>
  )
}
