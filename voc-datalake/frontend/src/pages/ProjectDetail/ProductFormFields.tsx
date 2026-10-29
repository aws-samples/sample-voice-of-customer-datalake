/**
 * @fileoverview The Product tab's form controls: a text input, a wrapping textarea
 * and the lifecycle select, each labelled by the shared `LabeledField` and saved
 * on blur (text) or on change (select). "Saving…" shows under the field being saved.
 *
 * @module pages/ProjectDetail/ProductFormFields
 */
import { useState, type ChangeEvent } from 'react'
import { LabeledField } from '../../components/LabeledField/LabeledField'

/** What every control shares: its label, the saved value and the "Saving…" hint while it saves. */
interface FieldProps {
  readonly label: string
  readonly value: string
  /** Shown under the field while its save is in flight. */
  readonly savingHint?: string
  readonly onSave: (v: string) => void
}

interface DraftFieldProps extends FieldProps {
  readonly max: number
}

/**
 * A local draft of `value` that re-seeds when the saved value changes (a save, or
 * the assistant's approved `update_product_context` refreshing the query). Adjusting
 * state during render with a guard is the React-recommended replacement for a
 * setState-in-effect sync.
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
function draftControlAttributes(id: string, { value, max, onSave }: DraftFieldProps, draft: string, setDraft: (next: string) => void) {
  return {
    id,
    value: draft,
    maxLength: max,
    onChange: (e: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onBlur: () => { if (draft !== value) onSave(draft) },
  }
}

export function TextField(props: DraftFieldProps) {
  const { draft, setDraft } = useSyncedDraft(props.value)
  return (
    <LabeledField label={props.label} hint={props.savingHint}>
      {(id) => <input type="text" className="input w-full" {...draftControlAttributes(id, props, draft, setDraft)} />}
    </LabeledField>
  )
}

/** Wraps long text instead of cutting it off, and can be resized vertically. */
export function TextAreaField(props: DraftFieldProps & { readonly rows: number }) {
  const { draft, setDraft } = useSyncedDraft(props.value)
  return (
    <LabeledField label={props.label} hint={props.savingHint}>
      {(id) => (
        <textarea rows={props.rows} className="input w-full resize-y" {...draftControlAttributes(id, props, draft, setDraft)} />
      )}
    </LabeledField>
  )
}

export function SelectField({
  label, value, options, savingHint, onSave,
}: FieldProps & { readonly options: readonly { value: string; label: string }[] }) {
  return (
    <LabeledField label={label} hint={savingHint}>
      {(id) => (
        <select id={id} value={value} onChange={(e) => onSave(e.target.value)} className="select w-full">
          {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )}
    </LabeledField>
  )
}
