/**
 * @fileoverview Compare and merge (D6-4): the latest version's changes over the version this draft was made on, one
 * block-level change at a time (diff/merge.ts, Revise's exactly-once rule). A change that still applies to the draft
 * is offered, ticked, as "Take this change"; one the draft already holds says so; a true conflict shows the two sides
 * side by side and is never taken (the draft keeps yours). Merging takes the ticked ones into the draft, which then
 * stands on the latest version: its next Save is checked against that one. Nothing is saved here.
 *
 * @module components/Document/conflict/MergeDialog
 */
import clsx from 'clsx'
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import DialogClose from '../../DialogClose/DialogClose'
import ModalShell from '../../ModalShell/ModalShell'
import type { MergeChange } from '../diff/merge'

interface MergeDialogProps {
  /** Null: the texts are too large to compare block by block. */
  readonly changes: readonly MergeChange[] | null
  readonly onTake: (changeIds: readonly string[]) => void
  readonly onClose: () => void
}

const STATUS_TONE = { applies: 'badge-info', already: 'badge-muted', conflict: 'badge-warn' } as const

function Passage({ label, text }: Readonly<{ label: string; text: string }>) {
  return (
    <div className="min-w-0">
      <p className="text-[12px] font-medium text-muted">{label}</p>
      <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-accent p-2 font-mono text-[12px]">
        {text === '' ? '\u00a0' : text}
      </pre>
    </div>
  )
}

function ChangeRow({ change, taken, onToggle }: Readonly<{ change: MergeChange; taken: boolean; onToggle: () => void }>) {
  const { t } = useTranslation('documents')
  return (
    <li role="group" aria-label={t(`conflict.status.${change.status}`)} className="space-y-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className={clsx('badge', STATUS_TONE[change.status])}>{t(`conflict.status.${change.status}`)}</span>
        {change.status === 'applies' ? (
          <label className="ml-auto flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={taken} onChange={onToggle} />
            {t('conflict.take')}
          </label>
        ) : null}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Passage label={t('conflict.before')} text={change.before} />
        <Passage label={t('conflict.theirs')} text={change.after} />
      </div>
    </li>
  )
}

export default function MergeDialog({ changes, onTake, onClose }: MergeDialogProps) {
  const { t } = useTranslation('documents')
  const titleId = useId()
  const [taken, setTaken] = useState<ReadonlySet<string>>(
    () => new Set((changes ?? []).filter((change) => change.status === 'applies').map((change) => change.id)),
  )
  const toggle = (id: string) => setTaken((now) => {
    const next = new Set(now)
    if (!next.delete(id)) next.add(id)
    return next
  })
  const body = (() => {
    if (changes === null) return <p className="text-sm text-warn">{t('conflict.tooLarge')}</p>
    if (changes.length === 0) return <p className="text-sm text-muted">{t('conflict.nothing')}</p>
    return (
      <ul className="divide-y divide-border rounded-md border border-border">
        {changes.map((change) => (
          <ChangeRow key={change.id} change={change} taken={taken.has(change.id)} onToggle={() => toggle(change.id)} />
        ))}
      </ul>
    )
  })()
  return (
    <ModalShell isOpen onClose={onClose} ariaLabelledBy={titleId} panelClassName="w-full max-w-3xl">
      <div className="dialog-header justify-between">
        <div>
          <h2 id={titleId} className="dialog-title">{t('conflict.mergeTitle')}</h2>
          <p className="dialog-description">{t('conflict.mergeIntro')}</p>
        </div>
        <DialogClose onClick={onClose} />
      </div>
      <div className="dialog-body max-h-[70vh] space-y-3 overflow-y-auto">{body}</div>
      <div className="dialog-footer">
        <button type="button" className="btn btn-secondary" onClick={onClose}>{t('conflict.cancel')}</button>
        <button type="button" className="btn btn-primary" disabled={taken.size === 0} onClick={() => onTake([...taken])}>
          {t('conflict.takeChosen')}
        </button>
      </div>
    </ModalShell>
  )
}
