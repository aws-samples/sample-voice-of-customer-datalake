/**
 * @fileoverview The inline row that adds or renames a hidden field (UX §6): an ID checked as you type
 * (`^[a-z][a-z0-9_]{0,39}$`, no reserved name, and not used twice in the form), an optional label, focus on the ID.
 * Once the form has a real response the ID is locked (`Lock`, "Responses are stored under this id.") and only the
 * label changes.
 *
 * @module pages/FeedbackForms/tabs/hidden/HiddenFieldEditor
 */
import { useEffect, useId, useRef, useState } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleX, Info, Lock } from 'lucide-react'
import type { HiddenField } from '../../model/formsV2'
import { hiddenIdProblem } from './hiddenIds'
import type { HiddenIdProblem } from './hiddenIds'

function IdField({ id, value, locked, problem, inputRef, onChange }: Readonly<{
  id: string
  value: string
  locked: boolean
  problem: HiddenIdProblem | null
  inputRef: RefObject<HTMLInputElement | null>
  onChange: (value: string) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  return (
    <div className="min-w-0 sm:w-56">
      <span className="mb-1 flex items-center gap-1">
        <label htmlFor={id} className="text-[12px] font-medium text-text">{t('hidden.columns.id')}</label>
        {locked && <><Lock size={12} className="text-muted" aria-hidden="true" /><span className="inline-flex text-muted" title={t('hidden.locked')}><Info size={14} aria-hidden="true" /><span className="sr-only">{t('hidden.locked')}</span></span></>}
      </span>
      <input id={id} ref={inputRef} className="input font-mono" value={value} readOnly={locked}
        aria-invalid={problem !== null} aria-describedby={problem === null ? undefined : `${id}-problem`}
        onChange={(event) => onChange(event.target.value)} />
      {problem !== null && (
        <p id={`${id}-problem`} className="mt-1 flex items-start gap-1 text-[12px] text-danger">
          <CircleX size={13} className="mt-0.5 shrink-0" aria-hidden="true" />{t(`problems.${problem}`, { id: value })}
        </p>
      )}
    </div>
  )
}

export default function HiddenFieldEditor({ initial, taken, locked, onDone, onCancel }: Readonly<{
  /** The field renamed; null: a new one. */
  initial: HiddenField | null
  /** The other fields' ids. */
  taken: ReadonlySet<string>
  /** The ID can't change (the form has real responses). */
  locked: boolean
  onDone: (field: HiddenField) => void
  onCancel: () => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const base = useId()
  const idInput = useRef<HTMLInputElement>(null)
  const [id, setId] = useState(initial?.id ?? '')
  const [label, setLabel] = useState(initial?.label ?? '')
  const [touched, setTouched] = useState(false)
  useEffect(() => { idInput.current?.focus() }, [])
  const problem = locked ? null : hiddenIdProblem(id, taken)
  const shown = touched || id !== '' ? problem : null
  const done = () => {
    setTouched(true)
    if (problem === null) onDone(label.trim() === '' ? { id } : { id, label: label.trim() })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Enter') { event.preventDefault(); done() }
    if (event.key === 'Escape') { event.preventDefault(); onCancel() }
  }
  return (
    <div className="flex flex-col gap-2 rounded-md border border-accent bg-accent-subtle p-3 sm:flex-row sm:items-start" onKeyDown={onKeyDown}>
      <IdField id={`${base}-id`} value={id} locked={locked} problem={shown} inputRef={idInput} onChange={setId} />
      <div className="min-w-0 flex-1">
        <label htmlFor={`${base}-label`} className="mb-1 block text-[12px] font-medium text-text">{t('hidden.columns.label')}</label>
        <input id={`${base}-label`} className="input" value={label} onChange={(event) => setLabel(event.target.value)} />
      </div>
      <div className="flex gap-2 sm:pt-5">
        <button type="button" className="btn btn-secondary btn-sm" onClick={onCancel}>{t('hidden.cancel')}</button>
        <button type="button" className="btn btn-primary btn-sm" aria-disabled={problem === null ? undefined : true} onClick={done}>
          {initial === null ? t('hidden.add') : t('hidden.done')}
        </button>
      </div>
    </div>
  )
}
