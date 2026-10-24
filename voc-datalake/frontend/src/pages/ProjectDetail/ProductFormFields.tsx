/**
 * Form-field building blocks for the ProductTab context form.
 * Extracted from ProductTab.tsx to keep that file under the max-lines budget.
 */
import { Loader2 } from 'lucide-react'
import { useState, type ChangeEvent } from 'react'

/**
 * The DOM id for a context field's control.
 *
 * These labels used to be bare `<label>` elements with no `htmlFor` and inputs
 * with no `id`, so nothing tied the two together: a screen reader announced an
 * unlabelled text box, and clicking the label did not focus the field. The field
 * key is already unique within the form, so it makes a stable id without a hook.
 */
const fieldInputId = (field: string) => `product-context-${field}`

function FieldShell({
  label, field, inputId, savingField, highlight, children,
}: {
  readonly label: string
  readonly field: string
  /**
   * The id of the control `children` renders, so the label points at it.
   *
   * Required rather than derived from `field`: the shell cannot see whether its
   * children actually carry that id, and a `htmlFor` pointing at nothing is worse
   * for a screen reader than the unlabelled input this replaced. Making it a
   * parameter means any new caller has to supply the id it really rendered.
   */
  readonly inputId: string
  readonly savingField: string | null
  readonly highlight: boolean
  readonly children: React.ReactNode
}) {
  return (
    <div className={`transition-colors rounded-md ${highlight ? 'ring-2 ring-warn/30 ring-offset-2 ring-offset-white' : ''}`}>
      <div className="flex items-center justify-between mb-1">
        <label htmlFor={inputId} className="text-xs font-medium text-text">{label}</label>
        {savingField === field && <Loader2 size={12} className="animate-spin text-muted" />}
      </div>
      {children}
    </div>
  )
}

/** The props TextField and TextAreaField share: a saved value, a draft of it, and a save callback. */
interface DraftFieldProps {
  readonly label: string; readonly field: string; readonly value: string; readonly max: number
  readonly savingField: string | null; readonly highlight: boolean; readonly placeholder: string
  readonly onSave: (v: string) => void
}

/**
 * A local draft of `value` that re-seeds when the saved value changes (e.g. after
 * a successful save or external refresh). Adjusting state during render with a
 * guard is the React-recommended replacement for a setState-in-effect sync.
 */
function useSyncedDraft(value: string) {
  const [draft, setDraft] = useState(value)
  const [prevValue, setPrevValue] = useState(value)
  if (prevValue !== value) {
    setPrevValue(value)
    setDraft(value)
  }
  return { draft, setDraft }
}

/** The attributes the text input and the textarea share: controlled by the draft, saved on blur if changed. */
function draftControlAttributes(
  { field, value, max, placeholder, onSave }: DraftFieldProps,
  draft: string,
  setDraft: (next: string) => void,
) {
  return {
    id: fieldInputId(field),
    value: draft,
    maxLength: max,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => { if (draft !== value) onSave(draft) },
    className: 'input',
    placeholder,
  }
}

export function TextField(props: DraftFieldProps) {
  const { label, field, value, savingField, highlight } = props
  const { draft, setDraft } = useSyncedDraft(value)
  return (
    <FieldShell label={label} field={field} inputId={fieldInputId(field)} savingField={savingField} highlight={highlight}>
      <input type="text" {...draftControlAttributes(props, draft, setDraft)} />
    </FieldShell>
  )
}

export function TextAreaField(props: DraftFieldProps & { readonly rows: number }) {
  const { label, field, value, rows, savingField, highlight } = props
  const { draft, setDraft } = useSyncedDraft(value)
  return (
    <FieldShell label={label} field={field} inputId={fieldInputId(field)} savingField={savingField} highlight={highlight}>
      <textarea rows={rows} {...draftControlAttributes(props, draft, setDraft)} />
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
    <FieldShell label={label} field={field} inputId={fieldInputId(field)} savingField={savingField} highlight={highlight}>
      <select
        id={fieldInputId(field)}
        value={value}
        onChange={(e) => onSave(e.target.value)}
        className="select"
      >
        {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    </FieldShell>
  )
}
