/**
 * @fileoverview The code of one option, or of a matrix's row or column (UX §4.1): a mono field checked as it is
 * typed (its problem under it, the code committed on blur only when it has none), or, once the form has responses, the
 * locked code with why it cannot change (answers are stored under it).
 *
 * @module pages/FeedbackForms/questions/CodeCell
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Info, Lock } from 'lucide-react'

export default function CodeCell({ code, name, locked, lockedText, problemOf, onCode }: Readonly<{
  code: string
  /** The field's name ("Code of option 3"). */
  name: string
  locked: boolean
  lockedText: string
  /** The `problems.<code>` key of what is wrong with a typed code, '' when nothing. */
  problemOf: (typed: string) => string
  onCode: (value: string) => void
}>) {
  const { t } = useTranslation('feedbackForms')
  const [typed, setTyped] = useState<string | null>(null)
  const shown = typed ?? code
  const problem = typed === null ? '' : problemOf(typed)
  if (locked) {
    return (
      <span className="inline-flex items-center gap-1 font-mono text-[12px] text-muted">
        <Lock size={12} aria-hidden="true" /><span aria-label={name}>{code}</span>
        <span className="inline-flex text-muted" title={lockedText}><Info size={14} aria-hidden="true" /><span className="sr-only">{lockedText}</span></span>
      </span>
    )
  }
  return (
    <span className="block w-36 shrink-0">
      <input className="input w-full font-mono text-[12px]" aria-label={name} value={shown} aria-invalid={problem === '' ? undefined : true}
        onChange={(event) => setTyped(event.target.value)}
        onBlur={() => {
          if (typed !== null && problem === '' && typed !== code) onCode(typed)
          setTyped(null)
        }} />
      {problem !== '' && <span role="alert" className="mt-0.5 block text-[12px] text-danger">{t(`problems.${problem}`, { code: shown })}</span>}
    </span>
  )
}
