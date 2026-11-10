/**
 * @fileoverview A group of radio options, each with a label and a one-line hint (the Boards
 * section's template choice and audience mode), drawn the same way everywhere.
 * @module pages/Settings/boards/DescribedRadios
 */
import { useId } from 'react'
import { useTranslation } from 'react-i18next'

/** The translation keys of one option's label and hint (boardCopy.ts). */
export interface DescribedCopy { readonly labelKey: string; readonly descriptionKey: string }

export default function DescribedRadios<T extends string>({ options, copy, value, disabled = false, className, onChange }: Readonly<{
  options: readonly T[]
  copy: Readonly<Record<T, DescribedCopy>>
  value: T
  disabled?: boolean
  /** The options' container (a grid, a stack). */
  className: string
  onChange: (next: T) => void
}>) {
  const { t } = useTranslation('settings')
  const name = useId()
  return (
    <div className={className}>
      {options.map((option) => (
        <label key={option} className="flex items-start gap-2 rounded-md border border-border p-2 text-sm">
          <input type="radio" name={name} className="mt-1" checked={value === option} disabled={disabled}
            onChange={() => onChange(option)} />
          <span>
            <span className="block font-medium text-text-strong">{t(copy[option].labelKey)}</span>
            <span className="block text-xs text-muted">{t(copy[option].descriptionKey)}</span>
          </span>
        </label>
      ))}
    </div>
  )
}
