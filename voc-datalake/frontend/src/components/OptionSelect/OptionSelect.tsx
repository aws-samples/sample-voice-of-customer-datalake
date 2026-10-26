/**
 * @fileoverview A filter `<select>` with an "All …" first option: empty value = no filter
 * (`null`), any other option is the raw value, shown through `display`.
 * Shared by the Categories attribute filters and the Problem Analysis filter bar.
 * @module components/OptionSelect
 */

interface OptionSelectProps {
  readonly label: string
  readonly allLabel: string
  readonly options: readonly string[]
  readonly value: string | null
  readonly onChange: (value: string | null) => void
  /** How an option reads; the raw value stays the filter. */
  readonly display?: (option: string) => string
  readonly className?: string
}

const identity = (option: string) => option

export default function OptionSelect({ label, allLabel, options, value, onChange, display = identity, className = 'select w-auto' }: OptionSelectProps) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value === '' ? null : e.target.value)} aria-label={label} className={className}>
      <option value="">{allLabel}</option>
      {options.map((option) => <option key={option} value={option}>{display(option)}</option>)}
    </select>
  )
}
