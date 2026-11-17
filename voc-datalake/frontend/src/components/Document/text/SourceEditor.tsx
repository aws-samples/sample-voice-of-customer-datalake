/**
 * @fileoverview Plain text and prompts, edited as written (`.input`): the field grows with its lines up to 24, then
 * scrolls; its count against the limit ("Characters: 1,240 of 4,000", danger past it, the reason said beside it);
 * for a prompt, "Sent to the model as written." No Markdown preview: a prompt is not rendered.
 *
 * @module components/Document/text/SourceEditor
 */
import clsx from 'clsx'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { overLimit } from './limits'
import type { DocumentLimits } from '../types'

interface SourceEditorProps {
  readonly value: string
  readonly onChange: (value: string) => void
  /** The field's accessible name (the document's title). */
  readonly label: string
  readonly limits: DocumentLimits | undefined
  /** A prompt: the note that the model reads it exactly as written. */
  readonly prompt: boolean
}

const MIN_ROWS = 4
const MAX_ROWS = 24

export default function SourceEditor({ value, onChange, label, limits, prompt }: SourceEditorProps) {
  const { t } = useTranslation('documents')
  const countId = useId()
  const lines = value.split('\n').length
  const over = overLimit(value, limits)
  return (
    <div className="space-y-1.5">
      <textarea className="input font-mono text-[13px] leading-6" value={value} aria-label={label}
        aria-describedby={countId} aria-invalid={over === null ? undefined : true}
        rows={Math.min(MAX_ROWS, Math.max(MIN_ROWS, lines))} onChange={(event) => onChange(event.target.value)} />
      {/* A space between the parts (outside them: a name computation trims a span's own text), so the field's
          description reads as words; the flex row ignores it on screen. */}
      <p id={countId} className="flex flex-wrap gap-x-3 text-[12px] text-muted">
        {limits?.maxChars === undefined ? null : (
          <span className={clsx(over === 'chars' && 'text-danger')}>{t('count.chars', { n: value.length, max: limits.maxChars })}</span>
        )}
        {' '}
        {limits?.maxLines === undefined ? null : (
          <span className={clsx(over === 'lines' && 'text-danger')}>{t('count.lines', { n: lines, max: limits.maxLines })}</span>
        )}
        {' '}
        {prompt ? <span>{t('prompt.asWritten')}</span> : null}
      </p>
    </div>
  )
}
