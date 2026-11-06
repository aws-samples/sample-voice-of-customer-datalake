/**
 * @fileoverview A labelled whole-number input of the agent editor (budget, trigger thresholds):
 * the typed text is clamped to `[min, max]` (`clampInt`), and an empty or unreadable entry reads
 * as `min`, so the draft never holds a value the API would refuse.
 * @module pages/Agents/ClampedNumberField
 */
import { LabeledField } from '../../components/LabeledField/LabeledField'
import { clampInt } from './agentDraft'

export interface ClampedNumberFieldProps {
  readonly label: string
  readonly hint?: string
  readonly value: number
  readonly min: number
  readonly max: number
  readonly readOnly: boolean
  readonly onChange: (value: number) => void
}

export function ClampedNumberField({ label, hint, value, min, max, readOnly, onChange }: ClampedNumberFieldProps) {
  return (
    <LabeledField label={label} hint={hint}>
      {(id) => <input id={id} type="number" className="input w-full" disabled={readOnly} min={min} max={max} value={value}
        onChange={(e) => onChange(clampInt(e.target.value, min, max, min))} />}
    </LabeledField>
  )
}
