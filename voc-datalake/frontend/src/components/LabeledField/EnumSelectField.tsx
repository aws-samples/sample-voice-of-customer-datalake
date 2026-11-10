/**
 * @fileoverview A labelled `<select>` over a closed list of values (agent visibility, a threshold's
 * period, a workflow loop's stop rule, a board form's choices). The picked option is found in `choices`, so
 * the value handed to `onChange` is typed without an assertion and a value off the list is ignored.
 * @module components/LabeledField/EnumSelectField
 */
import { LabeledField } from './LabeledField'

export interface EnumSelectFieldProps<T extends string> {
  readonly label: string
  readonly hint?: string
  readonly choices: readonly T[]
  readonly value: T
  /** How a choice reads. */
  readonly display: (choice: T) => string
  readonly disabled?: boolean
  /** `full` (default) fills the field's column; `auto` sizes the select to its options. */
  readonly width?: 'full' | 'auto'
  readonly onChange: (value: T) => void
}

export function EnumSelectField<T extends string>({
  label, hint, choices, value, display, disabled = false, width = 'full', onChange,
}: EnumSelectFieldProps<T>) {
  return (
    <LabeledField label={label} hint={hint}>
      {(id) => (
        <select id={id} className={width === 'full' ? 'select w-full' : 'select w-auto'} disabled={disabled} value={value}
          onChange={(e) => {
            const picked = choices.find((choice) => choice === e.target.value)
            if (picked !== undefined) onChange(picked)
          }}>
          {choices.map((choice) => <option key={choice} value={choice}>{display(choice)}</option>)}
        </select>
      )}
    </LabeledField>
  )
}
