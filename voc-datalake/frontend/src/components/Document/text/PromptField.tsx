/**
 * @fileoverview A prompt that is a field of a larger document (an automation's instructions, a flow step's), saved by
 * its parent with the rest (§6.4 step 7, `save: 'parent'`): edited as written in the plain-text editor (SourceEditor:
 * its count against the limit, "Sent to the model as written."), and read only as visible text in the body font,
 * never a disabled input (part 5 N15). No Markdown preview: a prompt is not rendered.
 *
 * The parent's own validation takes no more than the limit, so typing stops there (the count still shows it).
 *
 * @module components/Document/text/PromptField
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import SourceEditor from './SourceEditor'

interface PromptFieldProps {
  /** The field's visible label (and its name). */
  readonly label: string
  /** A line under the label (what the prompt is for); null: none. */
  readonly hint: string | null
  readonly value: string
  readonly onChange: (value: string) => void
  /** Read only: the text as written, with no field. */
  readonly readOnly: boolean
  /** The most characters the parent saves. */
  readonly maxChars: number
}

export default function PromptField({ label, hint, value, onChange, readOnly, maxChars }: PromptFieldProps) {
  const { t } = useTranslation('documents')
  const id = useId()
  if (readOnly) {
    return (
      <div className="space-y-1">
        <p className="text-[12px] font-semibold text-muted">{label}</p>
        {value.trim() === ''
          ? <p className="text-sm text-muted">{t('surface.empty')}</p>
          : <p className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm text-text">{value}</p>}
        <p className="text-[12px] text-muted">{t('prompt.asWritten')}</p>
      </div>
    )
  }
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-semibold text-muted">{label}</label>
      {hint === null ? null : <p className="text-[12px] text-muted">{hint}</p>}
      <SourceEditor id={id} value={value} onChange={onChange} label={label} limits={{ maxChars }} prompt maxLength={maxChars} />
    </div>
  )
}
