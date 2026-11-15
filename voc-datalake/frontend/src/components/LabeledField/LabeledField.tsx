/**
 * @fileoverview A form field: a label wired to its control by a generated id,
 * and an optional hint underneath (its id is `<id>-hint`, for the control's
 * aria-describedby; `hintTone: 'danger'` when it says what is wrong). The control
 * is a render prop so it receives the id to put on itself.
 *
 * @module components/LabeledField
 */
import { useId } from 'react'
import type { ReactNode } from 'react'

export function LabeledField({ label, hint, hintTone = 'muted', children }: Readonly<{
  label: string; hint?: string; hintTone?: 'muted' | 'danger'; children: (id: string) => ReactNode
}>) {
  const id = useId()
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-[12px] font-medium text-muted">{label}</label>
      {children(id)}
      {hint !== undefined && <p id={`${id}-hint`} className={`text-[12px] ${hintTone === 'danger' ? 'text-danger' : 'text-muted'}`}>{hint}</p>}
    </div>
  )
}
