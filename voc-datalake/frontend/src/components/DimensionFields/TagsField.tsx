/**
 * @fileoverview Tags typed as text (`vip, billing; refund`). The text is the
 * field's own state; every edit that parses cleanly reports the tags list, and
 * an invalid tag is named under the field instead of being sent.
 *
 * Remount it (React `key`) to reset the text from new tags.
 *
 * @module components/DimensionFields/TagsField
 */
import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { MAX_TAGS, parseTagInput } from '../../api/dimensionsSchema'

interface TagsFieldProps {
  tags: readonly string[]
  onChange: (tags: string[]) => void
  /** Reports whether the current text can be saved. */
  onValidityChange?: (valid: boolean) => void
  label?: string
  disabled?: boolean
}

type TagProblem = { key: 'invalid' | 'tooMany'; value: string } | null

/** The tags the text parses to, and what (if anything) stops them being saved. */
function readTags(text: string): { tags: string[]; problem: TagProblem } {
  const { tags, invalid } = parseTagInput(text)
  if (invalid.length > 0) return { tags, problem: { key: 'invalid', value: invalid.join(', ') } }
  if (tags.length > MAX_TAGS) return { tags, problem: { key: 'tooMany', value: String(MAX_TAGS) } }
  return { tags, problem: null }
}

export default function TagsField({ tags, onChange, onValidityChange, label, disabled = false }: Readonly<TagsFieldProps>) {
  const { t } = useTranslation('components', { keyPrefix: 'dimensionFields' })
  const id = useId()
  const hintId = useId()
  const [text, setText] = useState(() => tags.join(', '))
  const { problem } = readTags(text)

  const update = (next: string) => {
    setText(next)
    const parsed = readTags(next)
    onValidityChange?.(parsed.problem === null)
    if (parsed.problem === null) onChange(parsed.tags)
  }

  return (
    <div>
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{label ?? t('tagsLabel')}</label>
      <input
        id={id}
        type="text"
        value={text}
        disabled={disabled}
        onChange={(event) => update(event.target.value)}
        placeholder={t('tagsPlaceholder')}
        aria-invalid={problem !== null}
        aria-describedby={hintId}
        className={problem === null ? 'input' : 'input border-danger'}
      />
      <p id={hintId} className={problem === null ? 'text-xs text-muted mt-1' : 'text-xs text-danger mt-1'}>
        {problem?.key === 'invalid' && t('tagsInvalid', { tags: problem.value })}
        {problem?.key === 'tooMany' && t('tagsTooMany', { max: problem.value })}
        {problem === null && t('tagsHint')}
      </p>
    </div>
  )
}
