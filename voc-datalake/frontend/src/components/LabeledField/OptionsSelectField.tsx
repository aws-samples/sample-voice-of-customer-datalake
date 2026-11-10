/**
 * @fileoverview A labelled full-width `<select>` over caller-built `{value, label}` options (an
 * arrow's target node, a token's project pin, a board filter, a product's lifecycle state), with an
 * optional first option standing for none (empty value). The value stays a plain string.
 * @module components/LabeledField/OptionsSelectField
 */
import { LabeledField } from './LabeledField'

interface SelectOption {
  readonly value: string
  readonly label: string
}

export interface OptionsSelectFieldProps {
  readonly label: string
  readonly hint?: string
  readonly value: string
  readonly options: readonly SelectOption[]
  /** The first option (value `''`), when the field may be left empty. */
  readonly noneLabel?: string
  readonly onChange: (value: string) => void
}

export function OptionsSelectField({ label, hint, value, options, noneLabel, onChange }: OptionsSelectFieldProps) {
  return (
    <LabeledField label={label} hint={hint}>
      {(id) => (
        <select id={id} className="select w-full" value={value} onChange={(e) => onChange(e.target.value)}>
          {noneLabel !== undefined && <option value="">{noneLabel}</option>}
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
      )}
    </LabeledField>
  )
}
