/**
 * @fileoverview A question's or an ending's id under Advanced (UX §3.4, §7): editable, checked as you type and
 * applied when the field is left (or on Enter), until the form's first real response; then read-only with a Lock and
 * the reason (D9: answers are stored under it).
 *
 * @module pages/FeedbackForms/questions/IdField
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { CircleX, Info, Lock } from 'lucide-react'

export default function IdField({ label, value, locked, lockedText, check, onCommit }: Readonly<{
  label: string
  value: string
  locked: boolean
  /** Why it can't change once there are responses. */
  lockedText: string
  /** What is wrong with a typed id (a `problems.<code>` key), '' when nothing. */
  check: (id: string) => string
  onCommit: (id: string) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const id = useId()
  const [typed, setTyped] = useState<string | null>(null)
  const shown = typed ?? value
  const problem = typed === null ? '' : check(typed)
  const commit = () => {
    if (typed !== null && problem === '' && typed !== value) onCommit(typed)
    setTyped(null)
  }
  if (locked) {
    return (
      <div>
        <p className="mb-1 flex items-center gap-1 text-sm font-medium text-text">{label}<span className="inline-flex text-muted" title={lockedText}><Info size={14} aria-hidden="true" /><span className="sr-only">{lockedText}</span></span></p>
        <p className="inline-flex items-center gap-1 font-mono text-[12px] text-muted"><Lock size={12} aria-hidden="true" />{value}</p>
      </div>
    )
  }
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text">{label}</label>
      <input id={id} className="input w-full font-mono text-[12px]" value={shown} aria-invalid={problem === '' ? undefined : true}
        aria-describedby={problem === '' ? undefined : `${id}-problem`}
        onChange={(event) => setTyped(event.target.value)} onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commit() } }} />
      {problem !== '' && (
        <p id={`${id}-problem`} role="alert" className="mt-1 flex items-center gap-1 text-[12px] text-danger">
          <CircleX size={12} aria-hidden="true" />{t(problem, { id: shown })}
        </p>
      )}
    </div>
  )
}
