/**
 * Form-field building blocks for the ProductTab context form.
 * Extracted from ProductTab.tsx to keep that file under the max-lines budget.
 */
import { Loader2 } from 'lucide-react'
import { useState } from 'react'

export function FieldShell({
  label, field, savingField, highlight, children,
}: {
  readonly label: string
  readonly field: string
  readonly savingField: string | null
  readonly highlight: boolean
  readonly children: React.ReactNode
}) {
  return (
    <div className={`transition-colors rounded-md ${highlight ? 'ring-2 ring-yellow-300 ring-offset-2 ring-offset-white' : ''}`}>
      <div className="flex items-center justify-between mb-1">
        <label className="text-xs font-medium text-gray-700">{label}</label>
        {savingField === field && <Loader2 size={12} className="animate-spin text-gray-400" />}
      </div>
      {children}
    </div>
  )
}

export function TextField({
  label, field, value, max, savingField, highlight, placeholder, onSave,
}: {
  readonly label: string; readonly field: string; readonly value: string; readonly max: number
  readonly savingField: string | null; readonly highlight: boolean; readonly placeholder: string
  readonly onSave: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  // Reset the draft when the saved value changes (e.g. after a successful
  // save or external refresh). Adjusting state during render with a guard is
  // the React-recommended replacement for a setState-in-effect sync.
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setDraft(value)
  }
  return (
    <FieldShell label={label} field={field} savingField={savingField} highlight={highlight}>
      <input
        type="text"
        value={draft}
        maxLength={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onSave(draft) }}
        className="w-full px-3 py-2 border rounded-md text-sm"
        placeholder={placeholder}
      />
    </FieldShell>
  )
}

export function TextAreaField({
  label, field, value, max, rows, savingField, highlight, placeholder, onSave,
}: {
  readonly label: string; readonly field: string; readonly value: string; readonly max: number; readonly rows: number
  readonly savingField: string | null; readonly highlight: boolean; readonly placeholder: string
  readonly onSave: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  // Same render-phase sync pattern as TextField above.
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setDraft(value)
  }
  return (
    <FieldShell label={label} field={field} savingField={savingField} highlight={highlight}>
      <textarea
        value={draft}
        rows={rows}
        maxLength={max}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onSave(draft) }}
        className="w-full px-3 py-2 border rounded-md text-sm"
        placeholder={placeholder}
      />
    </FieldShell>
  )
}

export function SelectField({
  label, field, value, options, savingField, highlight, onSave,
}: {
  readonly label: string; readonly field: string; readonly value: string
  readonly options: { value: string; label: string }[]
  readonly savingField: string | null; readonly highlight: boolean
  readonly onSave: (v: string) => void
}) {
  return (
    <FieldShell label={label} field={field} savingField={savingField} highlight={highlight}>
      <select
        value={value}
        onChange={(e) => onSave(e.target.value)}
        className="w-full px-3 py-2 border rounded-md text-sm bg-white"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </FieldShell>
  )
}
