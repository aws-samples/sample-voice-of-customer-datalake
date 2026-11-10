/**
 * @fileoverview Private / Public radio pair with a one-line explanation each.
 *
 * Used by the create-project modal and the sharing modal so both describe the
 * two settings in the same words. A real fieldset + radios (not styled buttons)
 * so the group is announced with its legend and arrow keys move the choice.
 *
 * @module components/VisibilityChoice
 */
import clsx from 'clsx'
import { Globe, Lock } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProjectVisibility } from '../../api/projectTypes'

interface VisibilityChoiceProps {
  readonly value: ProjectVisibility
  readonly onChange: (value: ProjectVisibility) => void
  readonly disabled?: boolean
}

const OPTIONS = [
  { value: 'private', Icon: Lock, labelKey: 'visibility.private', hintKey: 'visibility.privateHint' },
  { value: 'public', Icon: Globe, labelKey: 'visibility.public', hintKey: 'visibility.publicHint' },
] as const

export default function VisibilityChoice({
  value, onChange, disabled = false,
}: VisibilityChoiceProps) {
  const { t } = useTranslation('projects')
  const name = useId()
  return (
    <fieldset disabled={disabled}>
      <legend className="block text-sm font-medium text-text mb-1">{t('visibility.label')}</legend>
      <div className="space-y-2">
        {OPTIONS.map((option) => {
          const hintId = `${name}-${option.value}-hint`
          const checked = value === option.value
          return (
            <label
              key={option.value}
              className={clsx(
                'flex items-start gap-3 p-3 border rounded-lg cursor-pointer transition-colors',
                // Selected: accent border + subtle fill. Hover only lifts the border, never the selected colour.
                checked ? 'border-accent bg-accent-subtle' : 'border-border hover:border-border-strong',
                disabled && 'cursor-not-allowed opacity-40',
              )}
            >
              <input
                type="radio"
                name={name}
                value={option.value}
                checked={checked}
                onChange={() => onChange(option.value)}
                aria-describedby={hintId}
                className="mt-1 accent-accent"
              />
              <option.Icon size={16} className={clsx('mt-0.5 flex-shrink-0', checked ? 'text-accent-text' : 'text-muted')} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-text-strong">{t(option.labelKey)}</span>
                {/* `text-muted` is only 4.05:1 on the dark `bg-accent-subtle` fill, so the selected hint steps up to `text-text`. */}
                <span id={hintId} className={clsx('block text-xs', checked ? 'text-text' : 'text-muted')}>{t(option.hintKey)}</span>
              </span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
