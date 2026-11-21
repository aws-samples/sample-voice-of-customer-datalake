/**
 * @fileoverview "⇣ Paste list" (UX §4.1): one option per line, with a live count ("8 options · 1 duplicate skipped ·
 * 2 blank lines ignored"), then Add N options, or Replace all… (which asks first when the form has responses).
 *
 * @module pages/FeedbackForms/questions/PasteOptions
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmModal from '../../../components/ConfirmModal/ConfirmModal'
import { parsePastedList } from './choiceOps'

export default function PasteOptions({ existing, locked, onAdd, onReplace, onClose }: Readonly<{
  /** The labels the question has now (a pasted repeat of one is skipped). */
  existing: readonly string[]
  /** The form has responses: Replace all asks first. */
  locked: boolean
  onAdd: (labels: readonly string[]) => void
  onReplace: (labels: readonly string[]) => void
  onClose: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const [text, setText] = useState('')
  const [confirming, setConfirming] = useState(false)
  const added = parsePastedList(text, existing)
  const replaced = parsePastedList(text, [])
  const summary = [
    t('choice.paste.options', { count: added.labels.length }),
    ...(added.duplicates > 0 ? [t('choice.paste.duplicates', { count: added.duplicates })] : []),
    ...(added.blanks > 0 ? [t('choice.paste.blanks', { count: added.blanks })] : []),
  ].join(' · ')
  const replace = () => {
    onReplace(replaced.labels)
    setConfirming(false)
  }
  return (
    <div className="space-y-2 rounded-lg border border-border bg-bg-accent p-3">
      <label htmlFor={id} className="block text-sm font-medium text-text">{t('choice.paste.label')}</label>
      <textarea id={id} className="input min-h-[6rem] w-full" value={text} aria-describedby={`${id}-count`} onChange={(event) => setText(event.target.value)} />
      <p id={`${id}-count`} role="status" className="text-[12px] text-muted">{summary}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="btn btn-primary btn-sm" disabled={added.labels.length === 0}
          onClick={() => onAdd(added.labels)}>{t('choice.paste.add', { count: added.labels.length })}</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={replaced.labels.length === 0}
          onClick={() => (locked ? setConfirming(true) : replace())}>{t('choice.paste.replace')}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>{t('choice.paste.cancel')}</button>
      </div>
      <ConfirmModal isOpen={confirming} variant="warning" title={t('choice.paste.replaceTitle')} message={t('choice.paste.replaceMessage')}
        confirmLabel={t('choice.paste.replaceConfirm')} onConfirm={replace} onCancel={() => setConfirming(false)} />
    </div>
  )
}
