/**
 * @fileoverview A form field: a label wired to its control by a generated id,
 * and an optional hint underneath. The control is a render prop so it receives
 * the id to put on itself.
 *
 * @module components/LabeledField
 */
import { useId } from 'react'
import type { ReactNode } from 'react'

export function LabeledField({ label, hint, children }: Readonly<{ label: string; hint?: string; children: (id: string) => ReactNode }>) {
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">{label}</label>
      {children(id)}
      {hint !== undefined && <p className="text-[12px] text-muted">{hint}</p>}
    </div>
  )
}
