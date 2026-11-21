/**
 * @fileoverview The Validation tab's list editor (7.68.00): the success criteria (a text and an optional target out
 * of 5) and the tasks testers try (a text). Rows are added, edited and removed here; the parent saves them.
 * @module pages/ProjectDetail/validation/RowsEditor
 */
import { Plus, Trash2 } from 'lucide-react'
import { LIMITS, newRow } from './validationModel'
import type { EditorRow } from './validationModel'

interface RowsEditorProps {
  readonly rows: readonly EditorRow[]
  readonly onChange: (rows: EditorRow[]) => void
  readonly max: number
  readonly disabled: boolean
  /** The label of row `n` (1-based), its remove button's, and the add button's. */
  readonly rowLabel: (n: number) => string
  readonly removeLabel: (n: number) => string
  readonly addLabel: string
  /** The target column's label; omitted for tasks, which have none. */
  readonly targetLabel?: string
}

function RowFields({ row, index, props }: Readonly<{ row: EditorRow; index: number; props: RowsEditorProps }>) {
  const { rows, onChange, disabled, rowLabel, removeLabel, targetLabel } = props
  const update = (patch: Partial<EditorRow>) => onChange(rows.map((one) => (one.key === row.key ? { ...one, ...patch } : one)))
  return (
    <li className="flex flex-wrap items-center gap-2">
      <input type="text" value={row.text} maxLength={LIMITS.textChars} disabled={disabled} aria-label={rowLabel(index + 1)}
        onChange={(event) => update({ text: event.target.value })} className="input min-w-0 flex-1" />
      {targetLabel === undefined ? null : (
        <input type="number" inputMode="decimal" min={LIMITS.minTarget} max={LIMITS.maxTarget} step={0.5} value={row.target}
          disabled={disabled} aria-label={`${targetLabel} ${index + 1}`} placeholder="4"
          onChange={(event) => update({ target: event.target.value })} className="input w-20" />
      )}
      <button type="button" disabled={disabled} aria-label={removeLabel(index + 1)} className="btn btn-ghost btn-sm"
        onClick={() => onChange(rows.filter((one) => one.key !== row.key))}>
        <Trash2 size={14} aria-hidden />
      </button>
    </li>
  )
}

export default function RowsEditor(props: RowsEditorProps) {
  const { rows, onChange, max, disabled, addLabel } = props
  return (
    <div className="space-y-2">
      <ol className="space-y-2">
        {rows.map((row, index) => <RowFields key={row.key} row={row} index={index} props={props} />)}
      </ol>
      <button type="button" disabled={disabled || rows.length >= max} className="btn btn-secondary btn-sm"
        onClick={() => onChange([...rows, newRow()])}>
        <Plus size={14} aria-hidden />
        {addLabel}
      </button>
    </div>
  )
}
