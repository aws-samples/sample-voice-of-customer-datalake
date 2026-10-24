/**
 * @fileoverview One dimension as a native select (design-system `.select`):
 * "none" plus the values allowed under the parent's current value.
 *
 * @module components/DimensionFields/DimensionValueSelect
 */
import { useId } from 'react'
import { valuesUnder } from '../../api/dimensionsSchema'
import type { Dimension } from '../../api/dimensionsSchema'

interface DimensionValueSelectProps {
  dimension: Dimension
  value: string | undefined
  /** The parent dimension's selected value, which narrows the options. */
  parentValue: string | undefined
  onChange: (value: string | undefined) => void
  /** Label of the empty option ("Any" in a filter, "None" in an editor). */
  emptyLabel: string
  disabled?: boolean
  className?: string
}

export default function DimensionValueSelect({
  dimension, value, parentValue, onChange, emptyLabel, disabled = false, className = 'select',
}: Readonly<DimensionValueSelectProps>) {
  const id = useId()
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-xs font-medium text-text mb-1">{dimension.label}</label>
      <select
        id={id}
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === '' ? undefined : event.target.value)}
        className={className}
      >
        <option value="">{emptyLabel}</option>
        {valuesUnder(dimension, parentValue).map((v) => (
          <option key={v.name} value={v.name}>{v.label ?? v.name}</option>
        ))}
      </select>
    </div>
  )
}
